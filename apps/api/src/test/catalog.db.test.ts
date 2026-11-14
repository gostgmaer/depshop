/**
 * Catalog API integration tests: real app, PostgreSQL (*_api_test) and Redis.
 * Data is created through the real importer from a test source with the
 * fictional brand "Acme" plus the labeled development sample catalog.
 */
import {
  CatalogImporter,
  type SourceListing,
  catalogCacheKey,
  invalidateProductCaches,
  seedSampleCatalog,
} from "@dealmind/catalog";
import { RedisMetricsStore } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import type { ErrorResponseBody } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agent, type TestContext, createTestApp, signUp, truncateAll } from "./harness.js";

interface Page<T> {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; total: number; totalPages: number } };
}
type Json = Record<string, unknown>;

let ctx: TestContext;
let anon: Agent;
let clock: Date;
let importer: CatalogImporter;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const SOURCE = "acme_store";
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

async function load(listings: SourceListing[]) {
  const s = await importer.importListings(SOURCE, listings);
  expect(s.rejected).toBe(0);
  return s;
}

const get = async <T = Json>(url: string, status = 200): Promise<T> => {
  const res = await anon.get(url);
  expect(res.statusCode, res.body).toBe(status);
  return res.json<T>();
};
const data = async <T = Json>(url: string) => (await get<{ data: T }>(url)).data;
const errorOf = async (url: string, status: number) =>
  (await get<ErrorResponseBody>(url, status)).error;

async function productId(name: string): Promise<string> {
  return (await ctx.prisma.product.findFirstOrThrow({ where: { name } })).id;
}

beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await ctx.prisma.shoppingSource.create({
    data: {
      slug: SOURCE,
      name: "Acme Test Store",
      domain: "example.test",
      baseUrl: "https://shop.example.test",
      integrationKind: "PARTNER",
      status: "ACTIVE",
    },
  });
  // Each test starts with an empty catalog cache.
  for (const kind of ["categories", "product", "offer-summary", "offers", "history"]) {
    let cursor = "0";
    do {
      const [next, keys] = await ctx.redis.scan(
        cursor,
        "MATCH",
        `${catalogCacheKey(ctx.prefix, kind)}*`,
      );
      cursor = next;
      if (keys.length) await ctx.redis.del(...keys);
    } while (cursor !== "0");
  }
  clock = new Date();
  importer = new CatalogImporter(ctx.prisma, { now: () => clock });
  anon = new Agent(ctx.app);
});

describe("categories", () => {
  it("returns the seeded hierarchy as a tree and a flat list", async () => {
    const tree =
      await data<{ slug: string; children: { slug: string; children: { slug: string }[] }[] }[]>(
        "/api/v1/categories/tree",
      );
    const roots = tree.map((c) => c.slug).sort();
    expect(roots).toEqual(
      [
        "automotive",
        "beauty-personal-care",
        "books",
        "electronics",
        "fashion",
        "grocery",
        "home-kitchen",
        "sports-fitness",
      ].sort(),
    );
    const electronics = tree.find((c) => c.slug === "electronics")!;
    expect(electronics.children.map((c) => c.slug)).toEqual(
      expect.arrayContaining(["smartphones", "laptops", "tablets", "televisions"]),
    );
    const home = tree.find((c) => c.slug === "home-kitchen")!;
    expect(
      home.children.find((c) => c.slug === "home-appliances")?.children.map((c) => c.slug),
    ).toEqual(expect.arrayContaining(["refrigerators", "washing-machines", "air-conditioners"]));
    const flat = await data<unknown[]>("/api/v1/categories");
    expect(flat.length).toBe(await ctx.prisma.category.count());
  });

  it("returns a category with its breadcrumb, children and subtree product count", async () => {
    await load([listing()]);
    const byId = (await ctx.prisma.category.findUniqueOrThrow({ where: { slug: "electronics" } }))
      .id;
    const detail = await data<{
      breadcrumb: { slug: string }[];
      productCount: number;
      children: unknown[];
    }>(`/api/v1/categories/${byId}`);
    expect(detail.productCount).toBe(1); // counts the smartphones subtree
    expect(detail.children.length).toBeGreaterThan(5);
    const phones = await data<{ breadcrumb: { slug: string }[] }>("/api/v1/categories/smartphones");
    expect(phones.breadcrumb.map((c) => c.slug)).toEqual(["electronics", "smartphones"]);
    expect((await errorOf("/api/v1/categories/no-such-category", 404)).code).toBe("NOT_FOUND");
  });

  it("hides inactive categories", async () => {
    await ctx.prisma.category.update({ where: { slug: "books" }, data: { isActive: false } });
    const flat = await data<{ slug: string }[]>("/api/v1/categories");
    expect(flat.some((c) => c.slug === "books")).toBe(false);
    await get("/api/v1/categories/books", 404);
  });
});

describe("product listing: filters, sorting and pagination", () => {
  beforeEach(async () => {
    await seedSampleCatalog(ctx.prisma, { env: "test" });
    await load([
      listing({
        title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
        sellingPricePaise: 1_500_000,
      }),
      listing({
        title: "Acme Nova 7 5G (Glacier Blue, 8GB RAM, 256GB Storage)",
        sellingPricePaise: 1_700_000,
      }),
      listing({
        title: "Acme Juicer Max 750W",
        categorySlug: "kitchen-appliances",
        sellingPricePaise: 350_000,
        stockStatus: "OUT_OF_STOCK",
      }),
    ]);
    await ctx.prisma.product.update({
      where: { id: await productId("Acme Nova 7 5G") },
      data: { launchDate: new Date("2026-03-01") },
    });
  });

  it("paginates with total counts in meta", async () => {
    const p1 = await get<Page<{ id: string }>>("/api/v1/products?pageSize=4&sort=name");
    expect(p1.meta.pagination).toEqual({ page: 1, pageSize: 4, total: 9, totalPages: 3 });
    const p3 = await get<Page<{ id: string }>>("/api/v1/products?pageSize=4&page=3&sort=name");
    expect(p3.data).toHaveLength(1);
    const ids = new Set([...p1.data, ...p3.data].map((p) => p.id));
    expect(ids.size).toBe(5);
  });

  it("filters by category subtree, canonical brand, price, stock and launch date", async () => {
    const names = async (qs: string) =>
      (await get<Page<{ name: string }>>(`/api/v1/products?${qs}&sort=name`)).data.map(
        (p) => p.name,
      );
    expect(await names("category=smartphones")).toEqual([
      "Acme Nova 7 5G",
      "Apple iPhone 15",
      "OnePlus 12",
      "Samsung Galaxy S24 5G",
    ]);
    expect((await names("category=electronics")).length).toBe(7); // includes child categories
    expect(await names("brand=Apple Inc.")).toEqual([
      "Apple iPad (10th generation) Wi-Fi",
      "Apple iPhone 15",
      "Apple MacBook Air 13-inch M2",
    ]);
    expect(await names("maxPricePaise=500000")).toEqual([
      "Acme Juicer Max 750W",
      "Levi's Men's 511 Slim Fit Jeans",
    ]);
    expect(await names("minPricePaise=8000000")).toEqual(["Apple MacBook Air 13-inch M2"]);
    expect(await names("inStock=true&brand=acme")).toEqual(["Acme Nova 7 5G"]);
    expect(await names("launchedAfter=2026-01-01")).toEqual(["Acme Nova 7 5G"]);
    expect(await names("launchedBefore=2025-01-01")).toEqual([]);
    expect(await names("q=iphone")).toEqual(["Apple iPhone 15"]);
  });

  it("filters by specification (one variant must satisfy all), numerically or by text", async () => {
    const names = async (qs: string) =>
      (await get<Page<{ name: string }>>(`/api/v1/products?${qs}&sort=name`)).data.map(
        (p) => p.name,
      );
    expect(await names("spec=storage_gb:512")).toEqual(["Apple iPhone 15", "OnePlus 12"]);
    expect(await names("spec=storage_gb:256&spec=ram_gb:8")).toEqual([
      "Acme Nova 7 5G",
      "Apple MacBook Air 13-inch M2",
      "Samsung Galaxy S24 5G",
    ]);
    expect(await names("spec=color_family:silver")).toEqual([
      "Apple iPad (10th generation) Wi-Fi",
      "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
    ]);
    expect(await names("spec=size:32")).toEqual(["Levi's Men's 511 Slim Fit Jeans"]);
    // OnePlus 12 has 12GB/256GB and 16GB/512GB, but no single 12GB/512GB variant.
    expect(await names("spec=ram_gb:12&spec=storage_gb:512")).toEqual([]);
    expect(await names("spec=ram_gb:16&spec=storage_gb:512")).toEqual(["OnePlus 12"]);
  });

  it("sorts by price using the lowest fresh offer", async () => {
    const asc = (
      await get<Page<{ lowestPricePaise: number }>>("/api/v1/products?sort=price_asc&pageSize=100")
    ).data;
    const prices = asc.map((p) => p.lowestPricePaise);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const desc = (await get<Page<{ name: string }>>("/api/v1/products?sort=price_desc&pageSize=1"))
      .data;
    expect(desc[0]?.name).toBe("Apple MacBook Air 13-inch M2"); // highest lowest-price (sample)
  });

  it("rejects invalid queries with VALIDATION_ERROR", async () => {
    for (const qs of [
      "userId=x",
      "minPricePaise=500&maxPricePaise=100",
      "spec=RAM:8",
      "spec=ram_gb",
      "pageSize=1000",
      "page=0",
      "sort=cheapest",
      "launchedAfter=not-a-date",
      "minPricePaise=-1",
    ]) {
      expect((await errorOf(`/api/v1/products?${qs}`, 422)).code, qs).toBe("VALIDATION_ERROR");
    }
    expect((await errorOf("/api/v1/products?category=nope", 404)).code).toBe("NOT_FOUND");
  });
});

describe("product detail, variants, offers and history", () => {
  it("returns details with variants and an offer summary labeled as sample data", async () => {
    await seedSampleCatalog(ctx.prisma, { env: "test" });
    const id = await productId("Apple iPhone 15");
    const p = await data<Json & { variants: { variantKey: string }[] }>(`/api/v1/products/${id}`);
    expect(p).toMatchObject({
      name: "Apple iPhone 15",
      brand: "Apple",
      lowestPricePaise: 6_990_000,
      offerCount: 3,
      inStock: true,
      sampleData: true,
      specifications: {},
      gtin: null,
    });
    expect(p.variants).toHaveLength(3);
    expect(await data(`/api/v1/products/${id}/variants`)).toEqual(p.variants);
    await get(`/api/v1/products/00000000-0000-7000-8000-000000000000`, 404);
    expect((await errorOf("/api/v1/products/not-a-uuid", 422)).code).toBe("VALIDATION_ERROR");
  });

  it("lists offers cheapest first, only from active sources, and never presents stale offers as live", async () => {
    await load([
      listing({ externalId: "a", sellingPricePaise: 1_800_000 }),
      listing({ externalId: "b", sellingPricePaise: 1_700_000, shippingPaise: 4_900 }),
    ]);
    const id = await productId("Acme Nova 7 5G");
    const offers = await data<(Json & { source: Json })[]>(`/api/v1/products/${id}/offers`);
    expect(offers.map((o) => o.sellingPricePaise)).toEqual([1_700_000, 1_800_000]);
    expect(offers[0]).toMatchObject({
      currency: "INR",
      shippingPaise: 4_900,
      mrpPaise: 2_499_900,
      discountBasisPoints: 3_199,
      isStale: false,
      matchMethod: "NORMALIZED_TITLE", // "b" matched the product created by "a"
      source: { slug: SOURCE, isSample: false },
    });

    // Offer "a" was last observed 2 days ago: stale (default limit 24h).
    await ctx.prisma.productOffer.updateMany({
      where: { externalId: "a" },
      data: { observedAt: new Date(Date.now() - 48 * 3_600_000) },
    });
    await invalidateProductCaches(ctx.redis, ctx.prefix, [id]);
    expect((await data<unknown[]>(`/api/v1/products/${id}/offers`)).length).toBe(1);
    const all = await data<{ sellingPricePaise: number; isStale: boolean }[]>(
      `/api/v1/products/${id}/offers?includeStale=true`,
    );
    expect(all.map((o) => [o.sellingPricePaise, o.isStale])).toEqual([
      [1_700_000, false],
      [1_800_000, true],
    ]);
    // Stale offers never set the "current" lowest price.
    await ctx.prisma.productOffer.updateMany({
      where: { externalId: "b" },
      data: { observedAt: new Date(0) },
    });
    await invalidateProductCaches(ctx.redis, ctx.prefix, [id]);
    expect(await data(`/api/v1/products/${id}`)).toMatchObject({
      lowestPricePaise: null,
      offerCount: 0,
    });

    // A source that is no longer ACTIVE disappears from offers entirely.
    await ctx.prisma.shoppingSource.update({
      where: { slug: SOURCE },
      data: { status: "MAINTENANCE" },
    });
    await invalidateProductCaches(ctx.redis, ctx.prefix, [id]);
    expect(await data(`/api/v1/products/${id}/offers?includeStale=true`)).toEqual([]);
  });

  it("returns append-only price history (and the /price-history alias)", async () => {
    const l = listing({ externalId: "h" });
    await load([l]);
    clock = new Date(clock.getTime() + 60_000);
    await load([{ ...l, sellingPricePaise: 1_899_900 }]);
    clock = new Date(clock.getTime() + 60_000);
    await load([{ ...l, sellingPricePaise: 1_849_900, stockStatus: "LIMITED" }]);
    const id = await productId("Acme Nova 7 5G");
    const h = await data<{ points: Json[]; lowestPricePaise: number; highestPricePaise: number }>(
      `/api/v1/products/${id}/history?days=30`,
    );
    expect(h.points.map((p) => [p.sellingPricePaise, p.stockStatus, p.sourceSlug])).toEqual([
      [1_999_900, "IN_STOCK", SOURCE],
      [1_899_900, "IN_STOCK", SOURCE],
      [1_849_900, "LIMITED", SOURCE],
    ]);
    expect([h.lowestPricePaise, h.highestPricePaise]).toEqual([1_849_900, 1_999_900]);
    expect(await data(`/api/v1/products/${id}/price-history?days=30`)).toEqual(h);
    expect(
      (await data<{ points: unknown[] }>(`/api/v1/products/${id}/history?source=other`)).points,
    ).toEqual([]);
    expect((await errorOf(`/api/v1/products/${id}/history?days=0`, 422)).code).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("shared catalog and caching", () => {
  it("is the same global catalog for every user (and for anonymous visitors), never copied", async () => {
    await load([listing()]);
    const id = await productId("Acme Nova 7 5G");
    const alice = await signUp(ctx, "alice@example.com");
    const bob = await signUp(ctx, "bob@example.com");
    const seen = await Promise.all(
      [alice.agent, bob.agent, anon].map(
        async (a) => (await a.get(`/api/v1/products/${id}`)).json<{ data: Json }>().data,
      ),
    );
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]).toEqual(seen[2]);
    const list = await Promise.all(
      [alice.agent, bob.agent].map(
        async (a) => (await a.get("/api/v1/products")).json<Page<{ id: string }>>().data,
      ),
    );
    expect(list[0]?.map((p) => p.id)).toEqual([id]);
    expect(list[1]?.map((p) => p.id)).toEqual([id]);
    expect(await ctx.prisma.product.count()).toBe(1);
    expect(await ctx.prisma.productOffer.count()).toBe(1);
  });

  it("caches product details in shared catalog keys and serves fresh data after invalidation", async () => {
    await load([listing({ externalId: "c" })]);
    const id = await productId("Acme Nova 7 5G");
    expect(await data(`/api/v1/products/${id}`)).toMatchObject({ lowestPricePaise: 1_999_900 });
    expect(await ctx.redis.exists(catalogCacheKey(ctx.prefix, "product", id))).toBe(1);
    expect(
      await ctx.redis.ttl(catalogCacheKey(ctx.prefix, "offer-summary", id)),
    ).toBeLessThanOrEqual(60);

    // A write that bypasses invalidation is not visible until the TTL expires…
    await ctx.prisma.product.update({ where: { id }, data: { description: "changed" } });
    expect(await data(`/api/v1/products/${id}`)).toMatchObject({ description: null });

    // …while an import with the invalidation hook is visible immediately.
    importer = new CatalogImporter(ctx.prisma, {
      now: () => clock,
      onProductsChanged: (ids) => invalidateProductCaches(ctx.redis, ctx.prefix, ids),
    });
    await load([listing({ externalId: "c", sellingPricePaise: 1_499_900 })]);
    expect(await data(`/api/v1/products/${id}`)).toMatchObject({
      description: "changed",
      lowestPricePaise: 1_499_900,
    });
  });

  it("keeps serving the catalog when Redis is unavailable", async () => {
    await load([listing()]);
    const id = await productId("Acme Nova 7 5G");
    // Simulate a Redis outage on the live client: reads fall back to PostgreSQL.
    const original = ctx.redis.get.bind(ctx.redis);
    ctx.redis.get = () => Promise.reject(new Error("Connection is closed."));
    try {
      expect(await data(`/api/v1/products/${id}`)).toMatchObject({ name: "Acme Nova 7 5G" });
    } finally {
      ctx.redis.get = original;
    }
  });
});

describe("sources (connector status)", () => {
  it("lists every source with its honest connector status and reason", async () => {
    await seedSampleCatalog(ctx.prisma, { env: "test" });
    const all = await data<(Json & { slug: string })[]>("/api/v1/sources");
    const bySlug: Record<string, Json> = Object.fromEntries(all.map((s) => [s.slug, s]));
    expect(Object.keys(bySlug).sort()).toEqual(
      [
        "acme_store",
        "amazon_in",
        "croma",
        "dealmind_sample",
        "flipkart",
        "reliance_digital",
        "tata_cliq",
      ].sort(),
    );
    expect(bySlug.amazon_in).toMatchObject({
      connectorStatus: "PENDING_APPROVAL",
      available: false,
    });
    expect(bySlug.flipkart).toMatchObject({
      connectorStatus: "PENDING_CREDENTIALS",
      available: false,
    });
    expect(String(bySlug.croma?.statusReason)).toMatch(/partner/);
    expect(bySlug.dealmind_sample).toMatchObject({
      connectorStatus: "ACTIVE",
      isSample: true,
      available: true,
    });
    const status = await data<{ totalSources: number; activeSources: number }>(
      "/api/v1/sources/status",
    );
    expect(status).toMatchObject({ totalSources: 7, activeSources: 2 });
  });

  it("derives DEGRADED/FAILED from health and returns detail by id or slug with metrics, never secrets", async () => {
    await ctx.prisma.shoppingSource.update({
      where: { slug: SOURCE },
      data: { health: "DOWN", lastHealthError: "Circuit open after repeated failures" },
    });
    await new RedisMetricsStore(ctx.redis, ctx.prefix).record({
      sourceId: SOURCE,
      outcome: "TIMED_OUT",
      durationMs: 800,
      resultCount: 0,
      cached: false,
      errorCategory: "TIMEOUT",
      at: new Date(),
    });
    const bySlug = await data<Json & { metrics: Json; tuning: Json }>(`/api/v1/sources/${SOURCE}`);
    expect(bySlug).toMatchObject({
      connectorStatus: "FAILED",
      available: false,
      lastHealthError: "Circuit open after repeated failures",
      tuning: { timeoutMs: 8000, rateLimitPerMinute: 60, maxRetries: 2, cacheTtlSeconds: 300 },
      metrics: {
        requests: 1,
        failures: 1,
        timeouts: 1,
        errorsByCategory: { TIMEOUT: 1 },
        lastErrorCategory: "TIMEOUT",
      },
    });
    const byId = await data<Json>(`/api/v1/sources/${String(bySlug.id)}`);
    expect(byId).toEqual(bySlug);
    const raw = JSON.stringify(byId).toLowerCase();
    for (const secret of ["token", "secret", "password", "credential"])
      expect(raw).not.toContain(secret);

    await ctx.prisma.shoppingSource.update({
      where: { slug: SOURCE },
      data: { health: "DEGRADED" },
    });
    expect(await data(`/api/v1/sources/${SOURCE}`)).toMatchObject({
      connectorStatus: "DEGRADED",
      available: true,
    });
    await get("/api/v1/sources/nope", 404);
    expect((await errorOf("/api/v1/sources/Bad-Slug", 422)).code).toBe("VALIDATION_ERROR");
  });
});

describe("admin: manual match review", () => {
  async function pendingReview() {
    await load([listing({ title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)" })]);
    const s = await importer.importListings(SOURCE, [
      listing({ title: "Acme Nova 7 Pro 5G (8GB RAM, 128GB Storage)" }),
    ]);
    expect(s.sentToReview).toBe(1);
  }

  it("is admin-only", async () => {
    await pendingReview();
    expect((await anon.get("/api/v1/admin/catalog/match-reviews")).statusCode).toBe(401);
    const user = await signUp(ctx, "user@example.com");
    expect((await user.agent.get("/api/v1/admin/catalog/match-reviews")).statusCode).toBe(403);
    const review = await ctx.prisma.productMatchReview.findFirstOrThrow();
    const res = await user.agent.post(`/api/v1/admin/catalog/match-reviews/${review.id}/resolve`, {
      action: "create",
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.prisma.product.count()).toBe(1);
  });

  it("lists pending reviews with evidence and resolves them (audited, cache invalidated)", async () => {
    await pendingReview();
    const admin = await signUp(ctx, "admin@example.com", { role: "ADMIN" });
    const list = (await admin.agent.get("/api/v1/admin/catalog/match-reviews")).json<
      Page<Json & { id: string }>
    >();
    expect(list.meta.pagination.total).toBe(1);
    expect(list.data[0]).toMatchObject({
      status: "PENDING",
      method: "FUZZY_TITLE",
      candidateProduct: { name: "Acme Nova 7 5G" },
      evidence: { conflicts: ["pro"] },
    });
    const id = list.data[0]!.id;
    const baseId = await productId("Acme Nova 7 5G");

    const bad = await admin.agent.post(`/api/v1/admin/catalog/match-reviews/${id}/resolve`, {
      action: "match",
    });
    expect(bad.statusCode).toBe(422); // productId required for "match"

    const res = await admin.agent.post(`/api/v1/admin/catalog/match-reviews/${id}/resolve`, {
      action: "create",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ data: Json }>().data).toMatchObject({ status: "APPROVED" });
    expect(await ctx.prisma.product.count()).toBe(2);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: "admin.catalog_match_review_resolved" } }),
    ).toBe(1);

    const again = await admin.agent.post(`/api/v1/admin/catalog/match-reviews/${id}/resolve`, {
      action: "reject",
    });
    expect(again.statusCode).toBe(409);
    expect(baseId).toBeDefined();
  });
});
