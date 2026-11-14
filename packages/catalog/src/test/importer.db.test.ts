/**
 * Matching + import against a real PostgreSQL (pg_trgm). Listings use the
 * fictional brand "Acme" and example.test URLs: test fixtures, not catalog data.
 */
import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogImporter, SourceNotActiveError } from "../importer.js";
import type { SourceListing } from "../listing.js";
import { CatalogMatcher } from "../matcher.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
afterAll(() => prisma.$disconnect());

/** Appends a valid GS1 check digit. */
function barcode(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1)
    sum += Number(body[i]) * ((body.length - i) % 2 === 1 ? 3 : 1);
  return body + String((10 - (sum % 10)) % 10);
}

const SOURCE = "acme_store";
let invalidated: string[][] = [];
let importer: CatalogImporter;
let clock = new Date("2026-11-01T10:00:00Z");

beforeEach(async () => {
  await truncateAll(prisma);
  await prisma.shoppingSource.create({
    data: {
      slug: SOURCE,
      name: "Acme Test Store",
      domain: "example.test",
      baseUrl: "https://shop.example.test",
      integrationKind: "PARTNER",
      status: "ACTIVE",
    },
  });
  await prisma.category.create({ data: { slug: "smartphones", name: "Smartphones" } });
  invalidated = [];
  clock = new Date("2026-11-01T10:00:00Z");
  importer = new CatalogImporter(prisma, {
    onProductsChanged: (ids) => {
      invalidated.push(ids);
    },
    now: () => clock,
  });
});

let seq = 0;
function listing(overrides: Partial<SourceListing> = {}): SourceListing {
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
    ...overrides,
  };
}

async function one(l: SourceListing) {
  const summary = await importer.importListings(SOURCE, [l]);
  const outcome = summary.outcomes[0]!;
  return { summary, outcome };
}

describe("import: creation, variants and provenance", () => {
  it("creates a product, variant, offer and first price snapshot", async () => {
    const { summary, outcome } = await one(
      listing({ modelNumber: "AC-N7-5G", specifications: { display: "6.5 inch" } }),
    );
    expect(summary).toMatchObject({
      imported: 1,
      productsCreated: 1,
      variantsCreated: 1,
      offersCreated: 1,
      snapshotsCreated: 1,
    });
    expect(outcome.status).toBe("imported");
    const product = await prisma.product.findFirstOrThrow({
      include: { variants: true, category: true },
    });
    expect(product).toMatchObject({
      name: "Acme Nova 7 5G",
      normalizedName: "acme nova 7 5g",
      brand: "Acme",
      modelNumber: "AC-N7-5G",
      fingerprint: "acme:ACN75G",
      specifications: { display: "6.5 inch" },
    });
    expect(product.category?.slug).toBe("smartphones");
    expect(product.variants[0]?.attributes).toEqual({ ram_gb: 8, storage_gb: 128 });
    const offer = await prisma.productOffer.findFirstOrThrow();
    expect(offer).toMatchObject({
      productId: product.id,
      sellingPricePaise: 1_999_900n,
      mrpPaise: 2_499_900n,
      matchMethod: "NEW_PRODUCT",
      observedAt: clock,
      firstSeenAt: clock,
      title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)", // verbatim
    });
    expect(await prisma.priceSnapshot.count()).toBe(1);
    expect(invalidated).toEqual([[product.id]]);
  });

  it("puts different storage/RAM of one product in separate variants of the same product", async () => {
    await one(listing({ modelNumber: "AC-N7-5G" }));
    const { outcome } = await one(
      listing({
        modelNumber: "AC-N7-5G",
        title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 256GB Storage)",
      }),
    );
    await one(listing({ title: "Acme Nova 7 5G (Midnight Black, 12GB RAM, 256GB Storage)" }));
    expect(outcome).toMatchObject({
      status: "imported",
      productCreated: false,
      variantCreated: true,
      method: "MODEL_NUMBER",
    });
    expect(await prisma.product.count()).toBe(1);
    const keys = (await prisma.productVariant.findMany()).map((v) => v.variantKey).sort();
    expect(keys).toEqual([
      "ram_gb=12|storage_gb=256",
      "ram_gb=8|storage_gb=128",
      "ram_gb=8|storage_gb=256",
    ]);
  });

  it("never merges different generations into one product", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const { outcome } = await one(listing({ title: "Acme Nova 8 5G (8GB RAM, 128GB Storage)" }));
    expect(outcome).toMatchObject({ status: "imported", productCreated: true });
    expect(await prisma.product.count()).toBe(2);
  });

  it("never auto-merges a base model with its Pro line; sends it to review", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const { outcome } = await one(
      listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" }),
    );
    expect(outcome.status).toBe("review");
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.productOffer.count()).toBe(1); // no offer for the uncertain listing
    const review = await prisma.productMatchReview.findFirstOrThrow();
    expect(review.status).toBe("PENDING");
    expect(review.method).toBe("FUZZY_TITLE");
    expect(review.evidence).toMatchObject({ conflicts: ["pro"] });
  });

  it("treats a different model number as a different product even with a similar title", async () => {
    await one(listing({ modelNumber: "AC-N7-A" }));
    const { outcome } = await one(listing({ modelNumber: "AC-N7-B" }));
    expect(outcome).toMatchObject({ status: "imported", productCreated: true });
  });
});

describe("matching priority", () => {
  it("matches exactly by barcode (any equivalent form) and pins the variant", async () => {
    const upc = barcode("03600029145");
    const first = await one(listing({ barcode: upc }));
    // Same item, different title wording and no model number; EAN-13 form of the UPC.
    const { outcome } = await one(
      listing({ title: "ACME NOVA-7 5G Smartphone 128 GB", barcode: `0${upc}` }),
    );
    expect(outcome).toMatchObject({
      status: "imported",
      method: "IDENTIFIER",
      confidence: 10_000,
      productCreated: false,
    });
    if (first.outcome.status === "imported" && outcome.status === "imported") {
      expect(outcome.variantId).toBe(first.outcome.variantId);
    }
  });

  it("sends a barcode hit on another brand to review instead of merging", async () => {
    const code = barcode("890123456789");
    await one(listing({ barcode: code }));
    const { outcome } = await one(
      listing({
        brand: "Zenith",
        title: "Zenith Nova 7 5G (8GB RAM, 128GB Storage)",
        barcode: code,
      }),
    );
    expect(outcome.status).toBe("review");
    expect((await prisma.productMatchReview.findFirstOrThrow()).evidence).toMatchObject({
      conflicts: ["brand"],
    });
  });

  it("matches by brand alias + model number regardless of model formatting", async () => {
    await one(
      listing({
        brand: "Samsung Electronics",
        title: "Samsung Galaxy Test Phone",
        modelNumber: "SM-T999B",
      }),
    );
    const { outcome } = await one(
      listing({ brand: "SAMSUNG", title: "Galaxy Test Phone (Blue)", modelNumber: "sm t999b" }),
    );
    expect(outcome).toMatchObject({
      status: "imported",
      method: "MODEL_NUMBER",
      productCreated: false,
    });
    expect((await prisma.product.findFirstOrThrow()).brand).toBe("Samsung");
  });

  it("matches by exact normalized name", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const exact = await one(
      listing({ title: "ACME Nova 7 5G - Dual SIM (8GB RAM, 256GB Storage)" }),
    );
    expect(exact.outcome).toMatchObject({
      status: "imported",
      method: "NORMALIZED_TITLE",
      productCreated: false,
    });
  });

  it("does not merge weakly similar titles under the default thresholds", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    // pg_trgm similarity of the normalized names is ~0.48: below minSimilarity (0.55).
    const weak = await one(
      listing({ title: "Acme Nova 7 5G Glacier Edition (8GB RAM, 128GB Storage)" }),
    );
    expect(weak.outcome).toMatchObject({ status: "imported", productCreated: true });
  });

  it("honours configurable thresholds", () => {
    expect(
      () => new CatalogMatcher({ autoMatchBp: 7_000, reviewBp: 8_000, minSimilarity: 0.5 }),
    ).toThrow();
  });

  it("routes fuzzy matches between the thresholds to review", async () => {
    importer = new CatalogImporter(prisma, {
      matcher: new CatalogMatcher({ autoMatchBp: 9_000, reviewBp: 4_000, minSimilarity: 0.3 }),
      now: () => clock,
    });
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const { outcome } = await one(
      listing({ title: "Acme Nova 7 5G Glacier Edition (8GB RAM, 128GB Storage)" }),
    );
    expect(outcome.status).toBe("review");
    const review = await prisma.productMatchReview.findFirstOrThrow();
    expect(review.method).toBe("FUZZY_TITLE");
    expect(review.evidence).toHaveProperty("similarity");
    expect(review.confidence).toBeGreaterThanOrEqual(4_000);
    expect(review.confidence).toBeLessThan(9_000);
  });

  it("auto-matches fuzzy titles at or above the auto threshold", async () => {
    importer = new CatalogImporter(prisma, {
      matcher: new CatalogMatcher({ autoMatchBp: 4_500, reviewBp: 4_000, minSimilarity: 0.3 }),
      now: () => clock,
    });
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const { outcome } = await one(
      listing({ title: "Acme Nova 7 5G Glacier Edition (8GB RAM, 128GB Storage)" }),
    );
    expect(outcome).toMatchObject({
      status: "imported",
      method: "FUZZY_TITLE",
      productCreated: false,
    });
  });
});

describe("offers and price history", () => {
  it("never duplicates an offer: re-imports update it and append history only on change", async () => {
    const l = listing();
    await one(l);
    clock = new Date(clock.getTime() + 60_000);
    const same = await one(l); // unchanged within the refresh window
    expect(same.summary).toMatchObject({ offersCreated: 0, offersUpdated: 1, snapshotsCreated: 0 });

    clock = new Date(clock.getTime() + 60_000);
    const cheaper = await one({ ...l, sellingPricePaise: 1_899_900 });
    expect(cheaper.summary).toMatchObject({ offersUpdated: 1, snapshotsCreated: 1 });

    clock = new Date(clock.getTime() + 60_000);
    await one({ ...l, sellingPricePaise: 1_899_900, stockStatus: "OUT_OF_STOCK" });

    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000); // past the 6h refresh
    await one({ ...l, sellingPricePaise: 1_899_900, stockStatus: "OUT_OF_STOCK" });

    expect(await prisma.productOffer.count()).toBe(1);
    const offer = await prisma.productOffer.findFirstOrThrow();
    expect(offer.observedAt).toEqual(clock);
    const history = await prisma.priceSnapshot.findMany({ orderBy: { observedAt: "asc" } });
    expect(history.map((h) => [h.sellingPricePaise, h.stockStatus])).toEqual([
      [1_999_900n, "IN_STOCK"],
      [1_899_900n, "IN_STOCK"],
      [1_899_900n, "OUT_OF_STOCK"],
      [1_899_900n, "OUT_OF_STOCK"],
    ]);
  });

  it("does not create duplicate products or offers under concurrent imports", async () => {
    const ls = Array.from({ length: 6 }, (_, i) =>
      listing({
        externalId: `race-${i % 2}`,
        modelNumber: "AC-RACE",
        title: "Acme Race Phone (8GB RAM, 128GB Storage)",
      }),
    );
    await Promise.all(ls.map((l) => importer.importListings(SOURCE, [l])));
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.productVariant.count()).toBe(1);
    expect(await prisma.productOffer.count()).toBe(2);
  });

  it("fills missing product fields from later listings but never overwrites them", async () => {
    await one(listing({ modelNumber: "AC-N7", description: "First description" }));
    await one(
      listing({
        modelNumber: "AC-N7",
        description: "Other description",
        manufacturer: "Acme Ltd",
        specifications: { battery: "5000 mAh" },
      }),
    );
    expect(await prisma.product.findFirstOrThrow()).toMatchObject({
      description: "First description",
      manufacturer: "Acme Ltd",
      specifications: { battery: "5000 mAh" },
    });
  });
});

describe("validation and source rules", () => {
  it("rejects invalid listings and reports each one", async () => {
    const summary = await importer.importListings(SOURCE, [
      listing({ sellingPricePaise: -1 }),
      { ...listing(), title: undefined },
      listing({ productUrl: "https://evil.example.org/p/1" }), // not on the source's domain
      listing(),
    ]);
    expect(summary).toMatchObject({ received: 4, rejected: 3, imported: 1 });
    expect(summary.outcomes.map((o) => o.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "imported",
    ]);
  });

  it("refuses imports from sources that are not ACTIVE", async () => {
    await prisma.shoppingSource.update({ where: { slug: SOURCE }, data: { status: "DISABLED" } });
    await expect(importer.importListings(SOURCE, [listing()])).rejects.toBeInstanceOf(
      SourceNotActiveError,
    );
    await expect(importer.importListings("nope", [listing()])).rejects.toBeInstanceOf(
      SourceNotActiveError,
    );
    expect(await prisma.product.count()).toBe(0);
  });
});

describe("manual review resolution", () => {
  it("attaches an approved listing to the chosen product, or creates a new one", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    const pro = listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" });
    await one(pro);
    const review = await prisma.productMatchReview.findFirstOrThrow();

    const created = await importer.resolveReview(review.id, { action: "create" });
    expect(created).toMatchObject({
      status: "imported",
      productCreated: true,
      method: "NEW_PRODUCT",
    });
    expect(await prisma.product.count()).toBe(2);
    expect(
      (await prisma.productMatchReview.findUniqueOrThrow({ where: { id: review.id } })).status,
    ).toBe("APPROVED");
    await expect(importer.resolveReview(review.id, { action: "reject" })).rejects.toThrow(
      /already APPROVED/,
    );

    // Re-importing the same listing now updates its offer instead of re-reviewing.
    const again = await one(pro);
    expect(again.outcome).toMatchObject({ status: "imported", offerCreated: false });
  });

  it("rejects a review without touching the catalog", async () => {
    await one(listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" }));
    await one(listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" }));
    const review = await prisma.productMatchReview.findFirstOrThrow();
    expect(await importer.resolveReview(review.id, { action: "reject" })).toBeNull();
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.productOffer.count()).toBe(1);
  });
});
