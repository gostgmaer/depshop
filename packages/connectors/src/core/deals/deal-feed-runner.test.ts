/**
 * Deals feed: Flipkart feed paging (from the published response shape; invented values),
 * the mock feed, and the runner's eligibility, validation, threshold and limits.
 * No network is used.
 */
import { describe, expect, it } from "vitest";
import { FLIPKART_API_BASE, FlipkartConnector } from "../../flipkart/flipkart-connector.js";
import { MockConnector } from "../../mock/mock-connector.js";
import type { DealFeedPage, ShoppingConnector } from "../interfaces/connector.js";
import { MemoryRateLimiter } from "../rate-limiter/rate-limiter.js";
import { ConnectorRegistry } from "../registry/registry.js";
import type { SourceConfig } from "../registry/source-config.js";
import { DealFeedRunner, discountBp } from "./deal-feed-runner.js";

const TWENTY = 2_000;
const ctx = () => ({ signal: new AbortController().signal });

function source(slug: string, over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: `00000000-0000-7000-8000-${String(slug.length).padStart(12, "0")}`,
    slug,
    name: slug,
    status: "ACTIVE",
    isSample: true,
    timeoutMs: 1_000,
    rateLimitPerMinute: 1_000,
    maxRetries: 0,
    cacheTtlSeconds: 0,
    circuitFailureThreshold: 3,
    circuitOpenSeconds: 60,
    health: "UNKNOWN",
    ...over,
  };
}

function fkProduct(id: string, sp: number, mrp: number, inStock = true) {
  return {
    productBaseInfoV1: {
      productId: id,
      title: `Acme Test Product ${id}`,
      maximumRetailPrice: { amount: mrp, currency: "INR" },
      flipkartSellingPrice: { amount: sp, currency: "INR" },
      productUrl: `https://dl.flipkart.com/dl/test/p/${id}`,
      productBrand: "Acme",
      inStock,
      categoryPath: "Mobiles>Smartphones",
    },
  };
}

const FEED_1 = `${FLIPKART_API_BASE}/1.0/feeds/aff/category/mob.json?expiresAt=1&sig=x`;
const FEED_2 = `${FLIPKART_API_BASE}/1.0/feeds/aff/category/tvs.json?expiresAt=1&sig=y`;
const LISTING = {
  apiGroups: {
    affiliate: {
      apiListings: {
        mobiles: { availableVariants: { "v0.1.0": { get: "old" }, "v1.1.0": { get: FEED_1 } } },
        televisions: { availableVariants: { "v1.1.0": { get: FEED_2 } } },
      },
    },
  },
};

/** Serves the listing and two category feeds (the first with a second page). */
function flipkartFetch(seen: string[], over: Record<string, unknown> = {}): typeof fetch {
  const pages: Record<string, unknown> = {
    "/api/aff.json": LISTING,
    "/1.0/feeds/aff/category/mob.json": {
      productInfoList: [
        fkProduct("DEAL25", 7_500, 10_000), // 25% off
        fkProduct("SMALL10", 9_000, 10_000), // 10% off: not a deal
        fkProduct("OOS40", 6_000, 10_000, false), // out of stock
      ],
      nextUrl: `${FLIPKART_API_BASE}/1.0/feeds/aff/category/mob.json?page=2`,
    },
    "/1.0/feeds/aff/category/mob.json?page=2": {
      productInfoList: [fkProduct("DEAL50", 5_000, 10_000)],
      nextUrl: null,
    },
    "/1.0/feeds/aff/category/tvs.json": { productInfoList: [fkProduct("TV20", 40_000, 50_000)] },
    ...over,
  };
  const fake = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url.toString());
    const page = url.searchParams.get("page");
    const key = url.pathname.replace("/affiliate", "") + (page ? `?page=${page}` : "");
    const body = pages[key];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  };
  return fake;
}

async function drain(c: ShoppingConnector) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page: DealFeedPage = await c.fetchDeals!(
      { minDiscountBp: TWENTY, ...(cursor ? { cursor } : {}) },
      ctx(),
    );
    pages += 1;
    ids.push(...page.items.map((i) => (i as { externalId: string }).externalId));
    cursor = page.nextCursor;
  } while (cursor && pages < 10);
  return { ids, pages };
}

describe("Flipkart deals feed", () => {
  it("walks every category feed and its nextUrl pages, keeping in-stock items ≥ 20% off", async () => {
    const seen: string[] = [];
    const c = new FlipkartConnector({
      affiliateId: "aff",
      token: "tok",
      fetch: flipkartFetch(seen),
    });
    expect(c.getCapabilities().dealFeed).toBe(true);
    const { ids, pages } = await drain(c);
    expect(ids).toEqual(["DEAL25", "DEAL50", "TV20"]);
    expect(pages).toBe(3);
    // The newest variant is used and the first page of each feed asks for in-stock items only.
    expect(seen.some((u) => u.includes("mob.json") && u.includes("inStock=true"))).toBe(true);
    expect(seen.some((u) => u.includes("old"))).toBe(false);
  });

  it("never sends the credentials to a host other than the API's", async () => {
    const seen: string[] = [];
    const evil = {
      apiGroups: {
        affiliate: {
          apiListings: {
            x: { availableVariants: { "v1.1.0": { get: "https://evil.example.test/feed.json" } } },
          },
        },
      },
    };
    const c = new FlipkartConnector({
      affiliateId: "aff",
      token: "tok",
      fetch: flipkartFetch(seen, { "/api/aff.json": evil }),
    });
    await expect(c.fetchDeals({ minDiscountBp: TWENTY }, ctx())).rejects.toMatchObject({
      category: "INVALID_RESPONSE",
    });
    expect(seen.some((u) => u.includes("evil"))).toBe(false);
  });

  it("is not fetched without credentials", async () => {
    const c = new FlipkartConnector({ fetch: flipkartFetch([]) });
    await expect(c.fetchDeals({ minDiscountBp: TWENTY }, ctx())).rejects.toMatchObject({
      category: "NOT_CONFIGURED",
    });
  });
});

describe("deals feed runner", () => {
  const mock = () => new MockConnector({ id: "mock_store_a", name: "Mock Store A" });

  it("hands over only validated deals ≥ the threshold, from eligible sources", async () => {
    const registry = new ConnectorRegistry().register(mock());
    const runner = new DealFeedRunner(
      registry,
      { list: async () => [source("mock_store_a"), source("flipkart", { status: "DISABLED" })] },
      { allowMocks: true, rateLimiter: new MemoryRateLimiter() },
    );
    const got: { sellingPricePaise: number; mrpPaise?: number }[] = [];
    const results = await runner.run(TWENTY, async (_s, items) => void got.push(...items));
    const a = results.find((r) => r.slug === "mock_store_a")!;
    expect(a.status).toBe("OK");
    expect(a.accepted).toBe(got.length);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((i) => (discountBp(i) ?? 0) >= TWENTY)).toBe(true);
    // The 15%-off fixture laptop is not a 20% deal.
    expect(got.some((i) => i.mrpPaise === 6_499_000)).toBe(false);
    expect(results.find((r) => r.slug === "flipkart")).toMatchObject({
      status: "SKIPPED",
      reason: "SOURCE_NOT_ACTIVE",
    });
  });

  it("never runs mock stores unless allowed", async () => {
    const runner = new DealFeedRunner(
      new ConnectorRegistry().register(mock()),
      { list: async () => [source("mock_store_a")] },
      { allowMocks: false },
    );
    const results = await runner.run(TWENTY, async () => undefined);
    expect(results).toEqual([
      expect.objectContaining({ status: "SKIPPED", reason: "MOCK_NOT_ALLOWED" }),
    ]);
  });

  it("drops invalid and foreign items, and stops a failing store without stopping others", async () => {
    const bad: ShoppingConnector = {
      ...mock(),
      id: "bad_store",
      name: "Bad",
      isMock: false,
      getCapabilities: () => mock().getCapabilities(),
      getReadiness: () => ({ state: "READY" }),
      search: async () => ({ sourceId: "bad_store", items: [], fetchedAt: new Date() }),
      getHealth: async () => ({ status: "HEALTHY", checkedAt: new Date() }),
      fetchDeals: async () => {
        throw new Error("boom");
      },
    };
    const odd: ShoppingConnector = {
      ...bad,
      id: "odd_store",
      fetchDeals: async () => ({
        sourceId: "odd_store",
        items: [
          { nonsense: true },
          { ...(await mock().fetchDeals({ minDiscountBp: 0 }, ctx())).items[0]! },
        ],
        fetchedAt: new Date(),
      }),
    };
    const registry = new ConnectorRegistry().register(bad).register(odd).register(mock());
    const runner = new DealFeedRunner(
      registry,
      { list: async () => [source("bad_store"), source("odd_store"), source("mock_store_a")] },
      { allowMocks: true },
    );
    const results = await runner.run(TWENTY, async () => undefined);
    expect(results.find((r) => r.slug === "bad_store")).toMatchObject({
      status: "FAILED",
      reason: "boom",
    });
    // One malformed item, one item from another store's id: both dropped.
    expect(results.find((r) => r.slug === "odd_store")).toMatchObject({ accepted: 0, dropped: 2 });
    expect(results.find((r) => r.slug === "mock_store_a")?.status).toBe("OK");
  });

  it("respects the per-source item limit", async () => {
    const runner = new DealFeedRunner(
      new ConnectorRegistry().register(mock()),
      { list: async () => [source("mock_store_a")] },
      { allowMocks: true, maxItemsPerSource: 2 },
    );
    let n = 0;
    const [r] = await runner.run(TWENTY, async (_s, items) => void (n += items.length));
    expect(n).toBe(2);
    expect(r).toMatchObject({ accepted: 2 });
  });
});
