/**
 * Matching + deduplication against a real PostgreSQL (pg_trgm, pgvector).
 * Listings are test fixtures (fictional "Acme"/"Zenith" items, example.test URLs).
 */
import { randomUUID } from "node:crypto";
import type { SourceListing } from "@dealmind/catalog";
import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogImporter, SourceNotActiveError } from "../deduplication/importer.js";
import { findDuplicateOffers, findDuplicateProducts } from "../deduplication/duplicates.js";
import { MatchingEngine } from "../engine.js";
import { LexicalHashEmbedder } from "../matchers/semantic-matcher.js";
import { trigramSimilarity } from "../normalizers/title.js";
import { MatchReviewService, ReviewNotAllowedError } from "../review/review-service.js";
import { MatchService } from "../service.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
afterAll(() => prisma.$disconnect());

const SOURCE = "acme_store";
const OTHER = "zenith_store";
let importer: CatalogImporter;
let clock = new Date("2026-11-01T10:00:00Z");
let adminId: string;

function barcode(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1)
    sum += Number(body[i]) * ((body.length - i) % 2 === 1 ? 3 : 1);
  return body + String((10 - (sum % 10)) % 10);
}

beforeEach(async () => {
  await truncateAll(prisma);
  for (const [slug, domain] of [
    [SOURCE, "example.test"],
    [OTHER, "zenith.example.test"],
  ] as const) {
    await prisma.shoppingSource.create({
      data: {
        slug,
        name: slug,
        domain,
        baseUrl: `https://${domain}`,
        integrationKind: "PARTNER",
        status: "ACTIVE",
      },
    });
  }
  await prisma.category.create({ data: { slug: "smartphones", name: "Smartphones" } });
  await prisma.category.create({ data: { slug: "laptops", name: "Laptops" } });
  adminId = (
    await prisma.user.create({
      data: { email: "admin@example.com", name: "A", iamUserId: randomUUID(), role: "ADMIN" },
    })
  ).id;
  clock = new Date("2026-11-01T10:00:00Z");
  importer = new CatalogImporter(prisma, { now: () => clock });
});

let seq = 0;
function listing(over: Partial<SourceListing> = {}): SourceListing {
  seq += 1;
  return {
    externalId: `ext-${seq}`,
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productUrl: `https://shop.example.test/p/${seq}`,
    brand: "Acme",
    categorySlug: "smartphones",
    sellingPricePaise: 1_999_900,
    mrpPaise: 2_499_900,
    stockStatus: "IN_STOCK",
    ...over,
  };
}

const one = async (l: SourceListing, source = SOURCE) =>
  (await importer.importListings(source, [l])).outcomes[0]!;

describe("1–3. identifier, MPN and brand+model matching", () => {
  it("matches an exact GTIN in any equivalent form and pins the variant", async () => {
    const upc = barcode("03600029145");
    const first = await one(listing({ barcode: upc }));
    const second = await one(
      listing({
        title: "ACME NOVA-7 5G Smartphone 8GB RAM 128GB Black",
        barcode: `0${upc}`,
        productUrl: "https://zenith.example.test/x",
      }),
      OTHER,
    );
    expect(second).toMatchObject({
      status: "imported",
      method: "IDENTIFIER",
      productCreated: false,
      variantCreated: false,
    });
    if (first.status === "imported" && second.status === "imported")
      expect(second.variantId).toBe(first.variantId);
  });

  it("matches a manufacturer part number (normalized) to its variant", async () => {
    const first = await one(listing({ mpn: "AC-N7-128-BLK" }));
    const second = await one(
      listing({
        title: "Acme Nova7 Black 128 GB",
        mpn: "acn7128blk",
        productUrl: "https://zenith.example.test/m",
      }),
      OTHER,
    );
    expect(second).toMatchObject({ status: "imported", method: "MPN", productCreated: false });
    if (first.status === "imported" && second.status === "imported")
      expect(second.variantId).toBe(first.variantId);
    expect((await prisma.productVariant.findFirstOrThrow()).mpn).toBe("ACN7128BLK");
  });

  it("matches brand alias + model number regardless of formatting", async () => {
    await one(
      listing({
        brand: "Samsung Electronics",
        title: "Samsung Galaxy Test 5G (8GB RAM, 128GB Storage)",
        modelNumber: "SM-T999B",
      }),
    );
    const r = await one(
      listing({
        brand: "SAMSUNG",
        title: "Galaxy Test 5G 128GB Storage 8GB RAM",
        modelNumber: "sm t999b",
      }),
    );
    expect(r).toMatchObject({
      status: "imported",
      method: "MODEL_NUMBER",
      productCreated: false,
      variantCreated: false,
    });
  });
});

describe("4–8. variants", () => {
  it("4. merges an identical variant listed by another source", async () => {
    const a = await one(listing({ modelNumber: "AC-N7" }));
    const b = await one(
      listing({ modelNumber: "AC-N7", productUrl: "https://zenith.example.test/n7" }),
      OTHER,
    );
    expect(b).toMatchObject({ status: "imported", productCreated: false, variantCreated: false });
    if (a.status === "imported" && b.status === "imported") expect(b.variantId).toBe(a.variantId);
    expect(await prisma.productOffer.count()).toBe(2);
  });

  it("5–6. never puts different RAM or storage in the same variant", async () => {
    await one(listing({ modelNumber: "AC-N7" }));
    const ram = await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (Midnight Black, 12GB RAM, 128GB Storage)",
      }),
    );
    const storage = await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 256GB Storage)",
      }),
    );
    expect([ram, storage].map((o) => o.status === "imported" && o.variantCreated)).toEqual([
      true,
      true,
    ]);
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.productVariant.count()).toBe(3);
  });

  it("7. never merges different generations (and holds one-sided line words for review)", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const gen = await one(listing({ title: "Acme Nova 8 5G (8GB RAM, 128GB Storage)" }));
    expect(gen).toMatchObject({ status: "imported", productCreated: true });
    const pro = await one(listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" }));
    expect(pro.status).toBe("review");
    expect(await prisma.product.count()).toBe(2);
  });

  it("8. normalizes colour names: same colour merges, a family-only match goes to review", async () => {
    await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
        attributes: { color: "Space Gray" },
      }),
    );
    const spelling = await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
        attributes: { color: "Space Grey" },
      }),
    );
    expect(spelling).toMatchObject({ status: "imported", variantCreated: false });
    const family = await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
        attributes: { color: "Graphite" },
      }),
    );
    expect(family.status).toBe("review");
  });

  it("holds a listing that doesn't state what the product's variants differ by", async () => {
    await one(listing({ modelNumber: "AC-N7" }));
    await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 256GB Storage)",
      }),
    );
    const vague = await one(
      listing({ modelNumber: "AC-N7", title: "Acme Nova 7 5G Midnight Black" }),
    );
    expect(vague.status).toBe("review");
  });
});

describe("9–10. fuzzy and semantic fallbacks never merge on their own", () => {
  it("9. a fuzzy title match goes to review, with its similarity as evidence", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const r = await one(listing({ title: "Acme Nova 7 5G Edition (8GB RAM, 128GB Storage)" }));
    // Similar but not identical title, no identifier: never auto-merged.
    expect(r.status).not.toBe("imported");
    const audit = await prisma.productMatchAudit.findFirstOrThrow({
      where: { decision: "MANUAL_REVIEW" },
    });
    expect(audit.method).toBe("FUZZY_TITLE");
    expect((audit.evidence as { titleSimilarity: number }).titleSimilarity).toBeGreaterThan(0.45);
  });

  it("10. the semantic fallback (pgvector) can surface a candidate for review only", async () => {
    // Test embedder: maps two synonym titles (no shared trigrams beyond the brand)
    // to nearly the same vector — standing in for a learned embedding model.
    const unit = (i: number) =>
      Array.from({ length: 256 }, (_, k) => (k === i ? 1 : k === i + 1 ? 0.05 : 0));
    const embedder = {
      model: "test-synonyms",
      embed: async (texts: string[]) =>
        texts.map((t) => (/aurora|cans/i.test(t) ? unit(3) : unit(100))),
    };
    importer = new CatalogImporter(prisma, {
      engine: new MatchingEngine({}, embedder),
      now: () => clock,
    });
    await one(listing({ title: "Acme Aurora Over-Ear Headphones", categorySlug: undefined }));
    const [countRow] = await prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM matching.product_embeddings`;
    expect(countRow?.n).toBe(1);
    const r = await one(listing({ title: "Acme Cans Q", categorySlug: undefined }));
    const audit = await prisma.productMatchAudit.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(r.status).toBe("review");
    expect(audit.method).toBe("SEMANTIC");
    expect(audit.scoreBp).toBeLessThan(9_000); // capped: semantic similarity never merges
  });

  it("the lexical-hash embedder is deterministic and unit-length", async () => {
    const [a, b] = await new LexicalHashEmbedder().embed(["Acme Nova 7", "Acme Nova 7"]);
    expect(a).toEqual(b);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it("uses the same trigram similarity as pg_trgm", async () => {
    for (const [a, b] of [
      ["acme nova 7 5g", "acme nova 7 5g glacier edition"],
      ["samsung galaxy s25 5g", "samsung s25 5g"],
      ["hp pavilion 15 intel core i5", "hp pavilion 15 laptop i5"],
    ] as const) {
      const [row] = await prisma.$queryRaw<
        { s: number }[]
      >`SELECT similarity(${a}, ${b})::float8 AS s`;
      expect(trigramSimilarity(a, b)).toBeCloseTo(row!.s, 6);
    }
  });
});

describe("11. duplicate offers", () => {
  it("treats the same page under another external id as one offer", async () => {
    const a = await one(
      listing({ productUrl: "https://shop.example.test/p/nova-7?utm_source=x&id=1" }),
    );
    const b = await one(
      listing({ productUrl: "https://www.shop.example.test/p/nova-7/?id=1&tag=aff" }),
    );
    expect(b).toMatchObject({ status: "imported", offerCreated: false });
    if (a.status === "imported" && b.status === "imported")
      expect(b.duplicateOfOfferId).toBe(a.offerId);
    expect(await prisma.productOffer.count()).toBe(1);
    expect(await prisma.productMatchAudit.count({ where: { decision: "DUPLICATE_OFFER" } })).toBe(
      1,
    );
    expect(await findDuplicateOffers(prisma)).toEqual([]);
  });

  it("re-imports update the same offer and append history only on change", async () => {
    const l = listing();
    await one(l);
    clock = new Date(clock.getTime() + 60_000);
    await one({ ...l, sellingPricePaise: 1_899_900 });
    expect(await prisma.productOffer.count()).toBe(1);
    expect(await prisma.priceSnapshot.count()).toBe(2);
  });
});

describe("12. manual review decisions (humans only)", () => {
  async function pending() {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const r = await one(listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" }));
    if (r.status !== "review") throw new Error("expected review");
    return r;
  }

  it("records the decision, then a human resolution (append-only audit)", async () => {
    const r = await pending();
    const reviews = new MatchReviewService(prisma, importer);
    const match = await reviews.getMatch(r.auditId);
    expect(match).toMatchObject({ decision: "MANUAL_REVIEW", review: { status: "PENDING" } });
    await reviews.review(
      r.auditId,
      { action: "create" },
      { userId: adminId, note: "Pro is a different line" },
    );
    expect(await prisma.product.count()).toBe(2);
    const after = await reviews.getMatch(r.auditId);
    expect(after?.resolutions).toHaveLength(1);
    expect(after?.resolutions[0]).toMatchObject({
      decision: "REVIEW_RESOLVED",
      reviewer: adminId,
      note: "Pro is a different line",
    });
    expect(after?.review).toMatchObject({ status: "APPROVED", reviewedBy: adminId });
    await expect(
      reviews.review(r.auditId, { action: "reject" }, { userId: adminId }),
    ).rejects.toThrow(/already/);
    // Audit rows can't be edited.
    await expect(
      prisma.productMatchAudit.update({ where: { id: r.auditId }, data: { note: "x" } }),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses non-admin (or unknown) reviewers", async () => {
    const r = await pending();
    const user = await prisma.user.create({
      data: { email: "u@example.com", name: "U", iamUserId: randomUUID() },
    });
    const reviews = new MatchReviewService(prisma, importer);
    await expect(
      reviews.review(r.auditId, { action: "create" }, { userId: user.id }),
    ).rejects.toBeInstanceOf(ReviewNotAllowedError);
    await expect(
      reviews.review(r.auditId, { action: "create" }, { userId: randomUUID() }),
    ).rejects.toBeInstanceOf(ReviewNotAllowedError);
    expect(await prisma.product.count()).toBe(1);
  });

  it("an approved match places the variant safely or requires the reviewer to choose", async () => {
    await one(listing({ modelNumber: "AC-N7" }));
    await one(
      listing({
        modelNumber: "AC-N7",
        title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 256GB Storage)",
      }),
    );
    const vague = await one(
      listing({ modelNumber: "AC-N7", title: "Acme Nova 7 5G Midnight Black" }),
    );
    if (vague.status !== "review") throw new Error("expected review");
    const product = await prisma.product.findFirstOrThrow();
    const reviews = new MatchReviewService(prisma, importer);
    await expect(
      reviews.review(
        vague.auditId,
        { action: "match", productId: product.id },
        { userId: adminId },
      ),
    ).rejects.toThrow(/ambiguous/);
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { variantKey: { contains: "storage_gb=256" } },
    });
    const res = await reviews.review(
      vague.auditId,
      { action: "match", productId: product.id, variantId: variant.id },
      { userId: adminId },
    );
    expect(res.outcome).toMatchObject({
      status: "imported",
      variantId: variant.id,
      method: "MANUAL",
    });
  });
});

describe("13. concurrent upserts", () => {
  it("creates one product, one variant and one offer per (source, external id) under concurrency", async () => {
    const ls = Array.from({ length: 8 }, (_, i) =>
      listing({
        externalId: `race-${i % 2}`,
        modelNumber: "AC-RACE",
        title: "Acme Race Phone (8GB RAM, 128GB Storage)",
        productUrl: `https://shop.example.test/race/${i % 2}`,
      }),
    );
    await Promise.all(ls.map((l) => importer.importListings(SOURCE, [l])));
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.productVariant.count()).toBe(1);
    expect(await prisma.productOffer.count()).toBe(2);
  });
});

describe("14. false-positive prevention & duplicate products", () => {
  it("never merges different laptops configs or a different brand with an identical title", async () => {
    await one(
      listing({
        categorySlug: "laptops",
        title: "Zenith X2 Laptop Intel Core i5 13th Gen 14 inch (16GB RAM, 512GB SSD)",
        brand: "Zenith",
      }),
    );
    const i7 = await one(
      listing({
        categorySlug: "laptops",
        title: "Zenith X2 Laptop Intel Core i7 13th Gen 14 inch (16GB RAM, 512GB SSD)",
        brand: "Zenith",
      }),
    );
    const other = await one(
      listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)", brand: "Orbit" }),
    );
    const first = await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    expect([i7, other, first].map((o) => o.status === "imported" && o.productCreated)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("reports likely duplicate products for review and merges them only on human approval", async () => {
    // Two catalog products that are really one (e.g. created before model numbers were known).
    const a = await prisma.product.create({
      data: { name: "Acme Nova 7 5G", normalizedName: "acme nova 7 5g", brand: "Acme" },
    });
    const b = await prisma.product.create({
      data: { name: "Acme Nova 7 5G", normalizedName: "acme nova 7 5g", brand: "Acme" },
    });
    const va = await prisma.productVariant.create({
      data: {
        productId: a.id,
        variantKey: "ram_gb=8|storage_gb=128",
        attributes: { ram_gb: 8, storage_gb: 128 },
      },
    });
    await prisma.productVariant.create({
      data: {
        productId: b.id,
        variantKey: "ram_gb=8|storage_gb=128",
        attributes: { ram_gb: 8, storage_gb: 128 },
      },
    });
    await prisma.productVariant.create({
      data: {
        productId: b.id,
        variantKey: "ram_gb=8|storage_gb=256",
        attributes: { ram_gb: 8, storage_gb: 256 },
      },
    });
    const engine = new MatchingEngine();
    const pairs = await findDuplicateProducts(prisma, engine, { record: true });
    expect(pairs).toHaveLength(1);
    expect(await prisma.product.count()).toBe(2); // detection never merges
    const reviews = new MatchReviewService(prisma, importer);
    await reviews.review(
      pairs[0]!.auditId!,
      { action: "merge", keepProductId: a.id },
      { userId: adminId },
    );
    expect(await prisma.product.count()).toBe(1);
    const keys = (await prisma.productVariant.findMany({ where: { productId: a.id } }))
      .map((v) => v.variantKey)
      .sort();
    expect(keys).toEqual(["ram_gb=8|storage_gb=128", "ram_gb=8|storage_gb=256"]);
    expect(await prisma.productVariant.findUnique({ where: { id: va.id } })).not.toBeNull();
  });

  it("refuses imports from sources that are not ACTIVE", async () => {
    await prisma.shoppingSource.update({ where: { slug: SOURCE }, data: { status: "DISABLED" } });
    await expect(importer.importListings(SOURCE, [listing()])).rejects.toBeInstanceOf(
      SourceNotActiveError,
    );
  });
});

describe("match service (dry run, internal API)", () => {
  it("matches without writing the catalog, audits, queues reviews, and deduplicates batch requests", async () => {
    await one(listing({ modelNumber: "AC-N7" }));
    const products = await prisma.product.count();
    const service = new MatchService(prisma, new MatchingEngine());
    const same = listing({ modelNumber: "AC-N7", productUrl: "https://zenith.example.test/n7" });
    const res = await service.match({ sourceId: OTHER, listing: same });
    expect(res).toMatchObject({
      decision: "AUTO_MERGE",
      method: "MODEL_NUMBER",
      confidence: "HIGH",
      variant: { relation: "SAME_VARIANT" },
    });
    expect(res.score).toBe(96);
    expect(await prisma.product.count()).toBe(products);
    expect(await prisma.productOffer.count()).toBe(1);
    const uncertain = listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" });
    const batch = await service.matchBatch([
      { sourceId: SOURCE, listing: uncertain },
      { sourceId: SOURCE, listing: uncertain },
      { listing: listing({ title: "Zenith Totally Different Product", brand: "Zenith" }) },
    ]);
    expect(batch.map((b) => b.decision)).toEqual(["MANUAL_REVIEW", "MANUAL_REVIEW", "NEW_PRODUCT"]);
    expect(batch[1]?.deduplicated).toBe(true);
    expect(batch[0]?.reviewId).toBeTruthy();
    expect(await prisma.productMatchAudit.count({ where: { origin: "INTERNAL_API" } })).toBe(3);
  });
});
