/**
 * Phase 4.2 search API: duplicate-submission guard, result re-ordering
 * (never re-ranking), ranking-mode reporting, owner isolation of results and
 * category filters derived from stored catalog data. Fictional "Acme" /
 * "Zenith" listings from a mock source.
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

let ctx: TestContext;
let seq = 0;

function listing(over: Partial<SourceListing> = {}): SourceListing {
  seq += 1;
  return {
    externalId: `r-${seq}`,
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productUrl: `https://mock-alpha.example.com/p/r-${seq}`,
    brand: "Acme",
    categorySlug: "smartphones",
    sellingPricePaise: 2_499_900,
    mrpPaise: 2_999_900,
    shippingPaise: 0,
    stockStatus: "IN_STOCK",
    ...over,
  };
}

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  ctx.iam.reset();
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
});

async function importOffers(listings: SourceListing[]): Promise<string[]> {
  const s = await new CatalogImporter(ctx.prisma).importListings("mock_alpha", listings);
  return listings.map((_, i) => {
    const o = s.outcomes.find((x) => x.index === i);
    if (o?.status !== "imported") throw new Error(`listing ${i} not imported`);
    return o.offerId;
  });
}

async function finishedSearch(userId: string, offerIds: string[], extra: object = {}) {
  const search = await ctx.prisma.search.create({
    data: { userId, query: "acme phone", filters: {}, status: "COMPLETED", ...extra },
  });
  await ctx.prisma.searchResult.createMany({
    data: offerIds.map((offerId, i) => ({
      userId,
      searchId: search.id,
      offerId,
      rank: i + 1,
      score: 1000 - i,
      pricePaiseAtSearch: 2_000_000n,
    })),
  });
  return search.id;
}

type ResultPage = {
  data: {
    rank: number;
    offer: { id: string };
    product: { modelNumber: string | null; launchDate: string | null };
    variantAttributes: Record<string, unknown>;
  }[];
  meta: { pagination: { total: number; totalPages: number; page: number } };
};

describe("POST /api/v1/search duplicate guard", () => {
  it("returns the running search for an identical resubmission, not a second one", async () => {
    const { agent } = await signUp(ctx, "dup@example.com");
    const body = { query: "acme nova", filters: { maxPricePaise: 3_000_000, brands: ["Acme"] } };
    const a = (await agent.post("/api/v1/search", body)).json<{ data: { id: string } }>().data;
    // Same filters in another key order are the same search.
    const b = (
      await agent.post("/api/v1/search", {
        query: "acme nova",
        filters: { brands: ["Acme"], maxPricePaise: 3_000_000 },
      })
    ).json<{ data: { id: string } }>().data;
    expect(b.id).toBe(a.id);
    const c = (
      await agent.post("/api/v1/search", { query: "acme nova", filters: { inStockOnly: true } })
    ).json<{ data: { id: string } }>().data;
    expect(c.id).not.toBe(a.id);
    expect(await ctx.prisma.search.count()).toBe(2);
    expect(await ctx.prisma.usageRecord.count({ where: { metric: "SEARCH" } })).toBe(2);
  });

  it("never returns another user's identical search", async () => {
    const alice = await signUp(ctx, "dup-a@example.com");
    const bob = await signUp(ctx, "dup-b@example.com");
    const a = (await alice.agent.post("/api/v1/search", { query: "zenith laptop" })).json<{
      data: { id: string };
    }>().data;
    const b = (await bob.agent.post("/api/v1/search", { query: "zenith laptop" })).json<{
      data: { id: string };
    }>().data;
    expect(b.id).not.toBe(a.id);
  });
});

describe("GET /api/v1/search/:id/results", () => {
  it("re-orders by current price or verified discount without changing the stored rank", async () => {
    const { agent, userId } = await signUp(ctx, "sort@example.com");
    const [a, b, c] = await importOffers([
      // 10% off a valid MRP
      listing({ sellingPricePaise: 2_700_000, mrpPaise: 3_000_000 }),
      // cheapest, no MRP stated (no verified discount)
      listing({
        title: "Acme Nova 7 5G (Midnight Black, 12GB RAM, 256GB Storage)",
        sellingPricePaise: 2_100_000,
        mrpPaise: undefined,
      }),
      // 30% off
      listing({
        title: "Zenith Pro 2 (Blue, 8GB RAM, 256GB Storage)",
        brand: "Zenith",
        sellingPricePaise: 2_450_000,
        mrpPaise: 3_500_000,
      }),
    ]);
    const id = await finishedSearch(userId, [a!, b!, c!]);
    const get = async (q: string) =>
      (await agent.get(`/api/v1/search/${id}/results${q}`)).json<ResultPage>();

    const byRank = await get("");
    expect(byRank.data.map((r) => r.offer.id)).toEqual([a, b, c]);
    expect(byRank.data[1]!.variantAttributes).toMatchObject({ ram_gb: 12, storage_gb: 256 });

    const byPrice = await get("?sort=price_asc");
    expect(byPrice.data.map((r) => r.offer.id)).toEqual([b, c, a]);
    // The stored rank is reported unchanged.
    expect(byPrice.data.map((r) => r.rank)).toEqual([2, 3, 1]);

    const byDiscount = await get("?sort=discount_desc");
    expect(byDiscount.data.map((r) => r.offer.id)).toEqual([c, a, b]);

    const paged = await get("?sort=price_asc&page=2&pageSize=2");
    expect(paged.data.map((r) => r.offer.id)).toEqual([a]);
    expect(paged.meta.pagination).toMatchObject({ total: 3, totalPages: 2, page: 2 });

    expect((await agent.get(`/api/v1/search/${id}/results?sort=affiliate`)).statusCode).toBe(422);
  });

  it("keeps results private to the owner", async () => {
    const alice = await signUp(ctx, "res-a@example.com");
    const bob = await signUp(ctx, "res-b@example.com");
    const [a] = await importOffers([listing()]);
    const id = await finishedSearch(alice.userId, [a!]);
    expect((await alice.agent.get(`/api/v1/search/${id}/results`)).statusCode).toBe(200);
    expect((await bob.agent.get(`/api/v1/search/${id}/results`)).statusCode).toBe(404);
    expect((await bob.agent.get(`/api/v1/search/${id}/results?sort=price_asc`)).statusCode).toBe(
      404,
    );
  });

  it("reports whether the user or the AI chose the ranking mode", async () => {
    const { agent, userId } = await signUp(ctx, "mode@example.com");
    const user = await finishedSearch(userId, [], { filters: { sortMode: "lowest_price" } });
    const ai = await finishedSearch(userId, [], {
      intent: { filters: { sort_mode: "highest_discount" } },
    });
    const none = await finishedSearch(userId, []);
    const ranking = async (id: string) =>
      (await agent.get(`/api/v1/search/${id}`)).json<{ data: { ranking: unknown } }>().data.ranking;
    expect(await ranking(user)).toEqual({ mode: "lowest_price", chosenBy: "user" });
    expect(await ranking(ai)).toEqual({ mode: "highest_discount", chosenBy: "ai" });
    expect(await ranking(none)).toBeNull();
  });
});

describe("GET /api/v1/categories/:slug/filters", () => {
  it("derives brands, price range and specification filters from stored data", async () => {
    await importOffers([
      listing({ sellingPricePaise: 2_000_000, shippingPaise: 5_000 }),
      listing({
        title: "Acme Nova 7 5G (Midnight Black, 12GB RAM, 256GB Storage)",
        sellingPricePaise: 3_000_000,
      }),
      listing({
        title: "Zenith Pro 2 (Blue, 8GB RAM, 256GB Storage)",
        brand: "Zenith",
        sellingPricePaise: 2_500_000,
      }),
    ]);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/categories/smartphones/filters",
    });
    expect(res.statusCode, res.body).toBe(200);
    const f = res.json<{
      data: {
        brands: { name: string; count: number }[];
        priceRange: { minPaise: number; maxPaise: number } | null;
        specs: { key: string; label: string; values: { value: string; label: string }[] }[];
        ratingsAvailable: boolean;
        productCount: number;
      };
    }>().data;
    expect(f.brands.map((b) => b.name).sort()).toEqual(["Acme", "Zenith"]);
    expect(f.priceRange).toEqual({ minPaise: 2_005_000, maxPaise: 3_000_000 });
    const ram = f.specs.find((s) => s.key === "ram_gb");
    expect(ram?.label).toBe("RAM");
    expect(ram?.values.map((v) => [v.value, v.label])).toEqual([
      ["8 GB", "8 GB"],
      ["12 GB", "12 GB"],
    ]);
    // Free-text colour names aren't offered as a filter.
    expect(f.specs.some((s) => s.key === "color")).toBe(false);
    expect(f.ratingsAvailable).toBe(false);

    // An empty category has no filters to invent.
    const empty = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/categories/laptops/filters",
    });
    expect(empty.json<{ data: unknown }>().data).toMatchObject({
      brands: [],
      priceRange: null,
      specs: [],
      productCount: 0,
    });
    expect(
      (await ctx.app.inject({ method: "GET", url: "/api/v1/categories/nope/filters" })).statusCode,
    ).toBe(404);
  });
});
