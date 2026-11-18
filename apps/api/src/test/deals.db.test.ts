/**
 * Public deals: built only from offers already stored (no marketplace call), and a
 * closed deal is hidden. "Closed" = no offer that is current (seen within the
 * freshness window), in stock, still listed and priced below its stated MRP.
 */
import type { DealView } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;
let n = 0;
const uid = () => `${Date.now()}-${++n}`;
const HOUR = 3_600_000;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
});

async function source(status: "ACTIVE" | "DISABLED" = "ACTIVE", isSample = false) {
  const slug = `src_${uid().replace(/-/g, "")}`;
  return ctx.prisma.shoppingSource.create({
    data: {
      slug,
      name: `Store ${slug.slice(-4)}`,
      domain: "example.test",
      baseUrl: "https://example.test",
      integrationKind: "PARTNER",
      status,
      isSample,
    },
  });
}

async function variant(name: string, categoryId?: string) {
  const product = await ctx.prisma.product.create({
    data: {
      name,
      normalizedName: name.toLowerCase(),
      brand: "Acme",
      fingerprint: `fp-${uid()}`,
      ...(categoryId ? { categoryId } : {}),
    },
  });
  return ctx.prisma.productVariant.create({
    data: { productId: product.id, variantKey: `k-${uid()}`, attributes: { ram_gb: 8 } },
  });
}

async function offer(
  v: { id: string; productId: string },
  sourceId: string,
  o: {
    price: number;
    mrp?: number | null;
    shipping?: number | null;
    stock?: "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK" | "UNKNOWN";
    ageHours?: number;
    missing?: boolean;
    expired?: boolean;
  },
) {
  return ctx.prisma.productOffer.create({
    data: {
      productId: v.productId,
      variantId: v.id,
      sourceId,
      externalId: `ext-${uid()}`,
      productUrl: "https://example.test/p",
      title: "Offer",
      sellingPricePaise: BigInt(o.price),
      mrpPaise: o.mrp === null ? null : BigInt(o.mrp ?? Math.round(o.price * 1.25)),
      shippingPaise: o.shipping == null ? null : BigInt(o.shipping),
      stockStatus: o.stock ?? "IN_STOCK",
      observedAt: new Date(Date.now() - (o.ageHours ?? 0) * HOUR),
      ...(o.missing ? { missingSince: new Date(), trackingState: "MISSING" as const } : {}),
      ...(o.expired ? { trackingState: "EXPIRED" as const } : {}),
    },
  });
}

const deals = async (qs = "") => {
  const res = await new Agent(ctx.app).get(`/api/v1/deals${qs}`);
  expect(res.statusCode).toBe(200);
  return res.json<{ data: DealView[]; meta: { pagination: { total: number } } }>();
};

describe("public deals", () => {
  it("needs no account and contacts no marketplace (stored offers only)", async () => {
    const s = await source();
    const v = await variant("Acme Nova");
    await offer(v, s.id, { price: 20_000_00, mrp: 25_000_00 });
    const body = await deals();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      name: "Acme Nova",
      offer: { sellingPricePaise: 20_000_00, mrpPaise: 25_000_00, discountBp: 2_000 },
      offerCount: 1,
    });
  });

  it("hides closed deals: stale, out of stock, removed, expired, no MRP, no discount, inactive source", async () => {
    const active = await source();
    const disabled = await source("DISABLED");
    const live = await variant("Live deal");
    await offer(live, active.id, { price: 10_000_00, mrp: 12_000_00 });
    const cases: [string, Parameters<typeof offer>[2], string?][] = [
      ["Stale", { price: 100, mrp: 200, ageHours: 48 }],
      ["Out of stock", { price: 100, mrp: 200, stock: "OUT_OF_STOCK" }],
      ["Unknown stock", { price: 100, mrp: 200, stock: "UNKNOWN" }],
      ["Removed", { price: 100, mrp: 200, missing: true }],
      ["Expired", { price: 100, mrp: 200, expired: true }],
      ["No MRP", { price: 100, mrp: null }],
      ["Discount ended", { price: 200, mrp: 200 }],
      ["Above MRP", { price: 300, mrp: 200 }],
      ["Inactive marketplace", { price: 100, mrp: 200 }, disabled.id],
    ];
    for (const [name, o, src] of cases) await offer(await variant(name), src ?? active.id, o);
    const names = (await deals()).data.map((d) => d.name);
    expect(names).toEqual(["Live deal"]);
  });

  it("one card per variant: its cheapest delivered live offer, with the count of live offers", async () => {
    const a = await source();
    const b = await source();
    const v = await variant("Two stores");
    await offer(v, a.id, { price: 20_000_00, mrp: 25_000_00, shipping: 0 });
    await offer(v, b.id, { price: 19_500_00, mrp: 25_000_00, shipping: 1_000_00 }); // dearer delivered
    await offer(v, b.id, { price: 1, mrp: 25_000_00, stock: "OUT_OF_STOCK" }); // not live
    const [deal] = (await deals()).data;
    expect(deal!.offer).toMatchObject({
      sourceSlug: a.slug,
      sellingPricePaise: 20_000_00,
      shippingPaise: 0,
    });
    expect(deal!.offerCount).toBe(2);
  });

  it("a deal reappears when a fresh discounted offer is seen again; the deepest discounts come first", async () => {
    const s = await source();
    const small = await variant("Small discount");
    const big = await variant("Big discount");
    await offer(small, s.id, { price: 95_00, mrp: 100_00 });
    await offer(big, s.id, { price: 50_00, mrp: 100_00 });
    expect((await deals()).data.map((d) => d.name)).toEqual(["Big discount", "Small discount"]);

    const gone = await variant("Back again");
    await offer(gone, s.id, { price: 80_00, mrp: 100_00, ageHours: 48 });
    expect((await deals()).data.map((d) => d.name)).not.toContain("Back again");
    await offer(gone, s.id, { price: 80_00, mrp: 100_00 });
    expect((await deals()).data.map((d) => d.name)).toContain("Back again");
  });

  it("filters by category and paginates; sample (mock) data is labelled", async () => {
    const cat = await ctx.prisma.category.create({ data: { slug: "phones-test", name: "Phones" } });
    const s = await source("ACTIVE", true);
    await offer(await variant("In category", cat.id), s.id, { price: 80_00, mrp: 100_00 });
    await offer(await variant("Elsewhere"), s.id, { price: 70_00, mrp: 100_00 });
    const filtered = await deals("?category=phones-test");
    expect(filtered.data.map((d) => d.name)).toEqual(["In category"]);
    expect(filtered.data[0]!.category).toEqual({ slug: "phones-test", name: "Phones" });
    expect(filtered.data[0]!.offer.isSample).toBe(true);
    const page1 = await deals("?pageSize=1");
    expect(page1.data).toHaveLength(1);
    expect(page1.meta.pagination.total).toBe(2);
  });
});
