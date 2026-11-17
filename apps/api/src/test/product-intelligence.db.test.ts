/**
 * Phase 4.3 product intelligence API: price history periods (incl. all
 * stored history) from real PriceSnapshot rows, stale offers never treated as
 * current, deterministic recommendations, cross-variant comparison, and
 * owner-scoped tracking history. Fictional "Acme" listings from a mock source.
 */
import type { SourceListing } from "@dealmind/catalog";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { CatalogImporter } from "@dealmind/intelligence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

const DAY = 86_400_000;
let ctx: TestContext;
let seq = 0;

function listing(over: Partial<SourceListing> = {}): SourceListing {
  seq += 1;
  return {
    externalId: `pi-${seq}`,
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productUrl: `https://mock-alpha.example.com/p/pi-${seq}`,
    brand: "Acme",
    categorySlug: "smartphones",
    sellingPricePaise: 2_499_900,
    mrpPaise: 2_999_900,
    shippingPaise: 0,
    stockStatus: "IN_STOCK",
    ...over,
  };
}

async function importInto(source: string, listings: SourceListing[]) {
  const s = await new CatalogImporter(ctx.prisma).importListings(source, listings);
  return listings.map((_, i) => {
    const o = s.outcomes.find((x) => x.index === i);
    if (o?.status !== "imported") throw new Error(`listing ${i} not imported`);
    return o;
  });
}

const get = <T>(url: string) =>
  ctx.app
    .inject({ method: "GET", url })
    .then((r) => ({ status: r.statusCode, body: r.json<{ data: T }>(), raw: r.body }));

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
});

type History = {
  points: { offerId: string; sellingPricePaise: number; observedAt: string }[];
  trackingSince: string | null;
  truncated: boolean;
  lowestPricePaise: number | null;
};

describe("GET /products/:id/history", () => {
  it("returns real observations for the period, all stored history, and when tracking began", async () => {
    const [o] = await importInto("mock_alpha", [listing()]);
    const offerId = o!.status === "imported" ? o!.offerId : "";
    const productId = o!.status === "imported" ? o!.productId : "";
    const now = Date.now();
    await ctx.prisma.priceSnapshot.createMany({
      data: [400, 100, 20, 5].map((d, i) => ({
        offerId,
        sellingPricePaise: BigInt(2_600_000 - i * 10_000),
        mrpPaise: 2_999_900n,
        stockStatus: "IN_STOCK" as const,
        observedAt: new Date(now - d * DAY),
      })),
    });
    const week = await get<History>(`/api/v1/products/${productId}/history?days=7`);
    expect(week.status, week.raw).toBe(200);
    // The import's own snapshot (now) and the one 5 days ago; nothing invented in between.
    expect(week.body.data.points.map((p) => p.sellingPricePaise)).toEqual([2_570_000, 2_499_900]);
    // Signed out: the FREE plan's 90-day history limit applies, and says so.
    const limited = await get<History & { planLimitDays: number | null }>(
      `/api/v1/products/${productId}/history?days=all`,
    );
    expect(limited.body.data.planLimitDays).toBe(90);
    expect(limited.body.data.points).toHaveLength(3);
    // A plan with unlimited history (0) returns everything stored.
    await ctx.prisma.subscriptionPlan.update({
      where: { code: "FREE" },
      data: { limits: { historyDays: 0 } },
    });
    const all = await get<History>(`/api/v1/products/${productId}/history?days=all`);
    await ctx.prisma.subscriptionPlan.update({ where: { code: "FREE" }, data: { limits: {} } });
    expect(all.body.data.points).toHaveLength(5);
    expect(all.body.data.trackingSince).toBe(all.body.data.points[0]!.observedAt);
    expect(Date.parse(all.body.data.trackingSince!)).toBeLessThan(now - 399 * DAY);
    expect(all.body.data.truncated).toBe(false);
    expect((await get(`/api/v1/products/${productId}/history?days=400`)).status).toBe(422);
  });

  it("keeps the newest observations when a period has more than the cap", async () => {
    const [o] = await importInto("mock_alpha", [listing()]);
    if (o!.status !== "imported") throw new Error();
    const now = Date.now();
    await ctx.prisma.priceSnapshot.createMany({
      data: Array.from({ length: 5_005 }, (_, i) => ({
        offerId: o!.offerId,
        sellingPricePaise: BigInt(2_000_000 + i),
        stockStatus: "IN_STOCK" as const,
        observedAt: new Date(now - (5_010 - i) * 60_000),
      })),
    });
    const h = await get<History>(`/api/v1/products/${o!.productId}/history?days=30`);
    expect(h.body.data.truncated).toBe(true);
    expect(h.body.data.points).toHaveLength(5_000);
    // The current observation (from the import) is never the one dropped.
    expect(h.body.data.points.at(-1)!.sellingPricePaise).toBe(2_499_900);
  });
});

type Pricing = {
  offers: {
    offer: { id: string; isStale: boolean };
    pricing: { prices: { deliveredPaise: number } };
  }[];
  comparison: { cheapestDelivered: string | null };
  recommendations: {
    considered: number;
    excluded: { reason: string; count: number }[];
    items: {
      kind: string;
      offerId: string | null;
      reasons: string[];
      unavailableReason: string | null;
    }[];
    basis: string;
  };
};

describe("GET /products/:id/pricing", () => {
  it("lists stale offers only on request, flagged, and never as lowest or recommended", async () => {
    const [fresh] = await importInto("mock_alpha", [listing({ sellingPricePaise: 2_499_900 })]);
    const [old] = await importInto("mock_beta", [
      listing({ sellingPricePaise: 1_999_900, productUrl: "https://mock-beta.example.com/p/x" }),
    ]);
    if (fresh!.status !== "imported" || old!.status !== "imported") throw new Error();
    expect(old!.productId).toBe(fresh!.productId);
    await ctx.prisma.productOffer.update({
      where: { id: old!.offerId },
      data: { observedAt: new Date(Date.now() - 3 * DAY) },
    });
    const base = `/api/v1/products/${fresh!.productId}/pricing?variantId=${fresh!.variantId}`;

    const current = await get<Pricing>(base);
    expect(current.body.data.offers.map((o) => o.offer.id)).toEqual([fresh!.offerId]);

    const withStale = await get<Pricing>(`${base}&includeStale=true`);
    expect(withStale.status, withStale.raw).toBe(200);
    const d = withStale.body.data;
    expect(d.offers.map((o) => [o.offer.id, o.offer.isStale])).toEqual([
      [old!.offerId, true],
      [fresh!.offerId, false],
    ]);
    // The cheaper stale offer is not "lowest", and not recommended.
    expect(d.comparison.cheapestDelivered).toBe(fresh!.offerId);
    const lowest = d.recommendations.items.find((i) => i.kind === "lowest_delivered");
    expect(lowest?.offerId).toBe(fresh!.offerId);
    expect(d.recommendations.items.map((i) => i.offerId)).not.toContain(old!.offerId);
    expect(d.recommendations.basis).toMatch(/Affiliate commission is not an input/);
  });
});

describe("GET /compare", () => {
  it("recommends across picked variants, per item and overall", async () => {
    const [a, b] = await importInto("mock_alpha", [
      listing({ sellingPricePaise: 2_499_900 }),
      listing({
        title: "Acme Nova 7 5G (Midnight Black, 12GB RAM, 256GB Storage)",
        sellingPricePaise: 2_899_900,
        mrpPaise: 3_999_900,
      }),
    ]);
    if (a!.status !== "imported" || b!.status !== "imported") throw new Error();
    expect(a!.variantId).not.toBe(b!.variantId);
    const items = `${a!.productId}:${a!.variantId},${b!.productId}:${b!.variantId}`;
    const r = await get<{
      items: { variantId: string; cheapestOfferId: string | null; offerCount: number }[];
      recommendations: Pricing["recommendations"];
    }>(`/api/v1/compare?items=${items}`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.data.items).toEqual([
      expect.objectContaining({
        variantId: a!.variantId,
        cheapestOfferId: a!.offerId,
        offerCount: 1,
      }),
      expect.objectContaining({
        variantId: b!.variantId,
        cheapestOfferId: b!.offerId,
        offerCount: 1,
      }),
    ]);
    const kind = (k: string) => r.body.data.recommendations.items.find((i) => i.kind === k);
    expect(kind("lowest_delivered")?.offerId).toBe(a!.offerId);
    // 27.5% off a stated MRP beats 16.66%.
    expect(kind("highest_direct_discount")?.offerId).toBe(b!.offerId);

    const unknownVariant = `${a!.productId}:20000000-0000-7000-8000-00000000abcd`;
    expect((await get(`/api/v1/compare?items=${unknownVariant}`)).status).toBe(404);
    expect((await get(`/api/v1/compare?items=nope`)).status).toBe(422);
  });
});

describe("tracking history filters (owner-scoped)", () => {
  it("lists only your alerts and watchlists for a variant", async () => {
    const [a, b] = await importInto("mock_alpha", [
      listing(),
      listing({ title: "Acme Nova 7 5G (Midnight Black, 12GB RAM, 256GB Storage)" }),
    ]);
    if (a!.status !== "imported" || b!.status !== "imported") throw new Error();
    const alice = await signUp(ctx, "track-a@example.com");
    const bob = await signUp(ctx, "track-b@example.com");
    for (const [who, variantId] of [
      [alice, a!.variantId],
      [alice, b!.variantId],
      [bob, a!.variantId],
    ] as const) {
      const res = await who.agent.post("/api/v1/alerts", {
        variantId,
        targetPricePaise: 2_000_000,
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const wl = (await alice.agent.post("/api/v1/watchlists", { name: "Phones" })).json<{
      data: { id: string };
    }>().data;
    await alice.agent.post("/api/v1/watchlists", { name: "Other" });
    expect(
      (await alice.agent.post(`/api/v1/watchlists/${wl.id}/items`, { variantId: a!.variantId }))
        .statusCode,
    ).toBe(201);

    const alerts = (await alice.agent.get(`/api/v1/alerts?variantId=${a!.variantId}`)).json<{
      data: { variant: { id: string } }[];
    }>().data;
    expect(alerts.map((x) => x.variant.id)).toEqual([a!.variantId]);
    const lists = (await alice.agent.get(`/api/v1/watchlists?variantId=${a!.variantId}`)).json<{
      data: { name: string }[];
    }>().data;
    expect(lists.map((x) => x.name)).toEqual(["Phones"]);
    // Bob sees only his own alert and none of Alice's watchlists.
    expect(
      (await bob.agent.get(`/api/v1/alerts?variantId=${a!.variantId}`)).json<{ data: unknown[] }>()
        .data,
    ).toHaveLength(1);
    expect(
      (await bob.agent.get(`/api/v1/watchlists?variantId=${a!.variantId}`)).json<{
        data: unknown[];
      }>().data,
    ).toEqual([]);
  });
});
