/**
 * Single-offer lookups for price tracking (scripted connectors, fictional data).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryMetricsStore } from "../health/metrics.js";
import type { ShoppingConnector } from "../interfaces/connector.js";
import { MemoryRateLimiter } from "../rate-limiter/rate-limiter.js";
import { ConnectorRegistry } from "../registry/registry.js";
import type { SourceConfig } from "../registry/source-config.js";
import { ConnectorError } from "../types/errors.js";
import type { NormalizedProductInput } from "../types/schemas.js";
import { ProductLookupExecutor } from "./lookup.js";

const source = (slug: string, over: Partial<SourceConfig> = {}): SourceConfig => ({
  id: "00000000-0000-7000-8000-000000000001",
  slug,
  name: slug,
  status: "ACTIVE",
  isSample: true,
  timeoutMs: 100,
  rateLimitPerMinute: 1_000,
  maxRetries: 2,
  cacheTtlSeconds: 0,
  circuitFailureThreshold: 2,
  circuitOpenSeconds: 60,
  health: "UNKNOWN",
  ...over,
});

function listing(
  slug: string,
  externalId: string,
  over: Partial<NormalizedProductInput> = {},
): NormalizedProductInput {
  const now = new Date();
  return {
    sourceId: slug,
    externalId,
    title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
    brand: "Acme",
    productUrl: `https://${slug.replace(/_/g, "-")}.example.com/p/1`,
    sellingPricePaise: 1_899_900,
    mrpPaise: 2_499_900,
    priceType: "LISTED",
    currency: "INR",
    stockStatus: "IN_STOCK",
    observedAt: now,
    provenance: { method: "MOCK", provider: "test", retrievedAt: now },
    ...over,
  };
}

type Script = (
  call: number,
  externalId: string,
  signal: AbortSignal,
) => Promise<NormalizedProductInput | null>;

class LookupDouble implements ShoppingConnector {
  calls = 0;
  readonly isMock = false;
  readonly name: string;
  constructor(
    readonly id: string,
    private readonly script: Script,
    private readonly canLookup = true,
  ) {
    this.name = id;
  }
  getCapabilities() {
    return {
      search: true,
      productLookup: this.canLookup,
      categories: "all" as const,
      price: true,
      mrp: true,
      stock: true,
      shipping: true,
      promotions: false,
      maxResultsPerRequest: 10,
    };
  }
  getReadiness() {
    return { state: "READY" as const };
  }
  async search() {
    return { sourceId: this.id, items: [], fetchedAt: new Date() };
  }
  async getProduct(externalId: string, ctx: { signal: AbortSignal }) {
    this.calls += 1;
    return this.script(this.calls, externalId, ctx.signal);
  }
  async getHealth() {
    return { status: "HEALTHY" as const, checkedAt: new Date() };
  }
}

let registry: ConnectorRegistry;
let sources: SourceConfig[];
let limiter: MemoryRateLimiter;
const exec = (over: Partial<ConstructorParameters<typeof ProductLookupExecutor>[0]> = {}) =>
  new ProductLookupExecutor({
    registry,
    sources: { list: async () => sources },
    rateLimiter: limiter,
    metrics: new MemoryMetricsStore(),
    random: () => 0,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    ...over,
  });

beforeEach(() => {
  registry = new ConnectorRegistry();
  sources = [source("store_a")];
  limiter = new MemoryRateLimiter();
});

describe("ProductLookupExecutor", () => {
  it("returns a validated listing and shares one upstream call for concurrent identical lookups", async () => {
    const c = new LookupDouble("store_a", async (_n, id) => {
      await new Promise((r) => setTimeout(r, 20));
      return listing("store_a", id);
    });
    registry.register(c);
    const e = exec();
    const all = await Promise.all([
      e.lookup("store_a", "x1"),
      e.lookup("store_a", "x1"),
      e.lookup("store_a", "x1"),
    ]);
    expect(all[0].status).toBe("FOUND");
    expect(all[0].item?.sellingPricePaise).toBe(1_899_900);
    expect(all.filter((r) => r.deduplicated)).toHaveLength(2);
    expect(c.calls).toBe(1);
  });

  it("reports NOT_FOUND and INVALID without inventing a price", async () => {
    registry.register(
      new LookupDouble("store_a", async (_n, id) => {
        if (id === "gone") return null;
        if (id === "bad") return listing("store_a", id, { sellingPricePaise: -5 });
        return listing("store_a", "other");
      }),
    );
    const e = exec();
    expect((await e.lookup("store_a", "gone")).status).toBe("NOT_FOUND");
    const bad = await e.lookup("store_a", "bad");
    expect(bad).toMatchObject({ status: "INVALID", retryable: false });
    expect(bad.item).toBeUndefined();
    expect((await e.lookup("store_a", "x1")).errorMessage).toBe(
      "Listing returned for a different id",
    );
  });

  it("skips sources that are inactive, disabled or can't look up listings", async () => {
    registry.register(new LookupDouble("store_a", async (_n, id) => listing("store_a", id)));
    registry.register(new LookupDouble("store_b", async (_n, id) => listing("store_b", id), false));
    sources.push(source("store_b"), source("store_c", { status: "PENDING_APPROVAL" }));
    const e = exec();
    expect(e.lookupCapableSlugs()).toEqual(["store_a"]);
    expect((await e.lookup("store_b", "x")).errorCode).toBe("NO_LOOKUP_CAPABILITY");
    expect((await e.lookup("store_c", "x")).errorCode).toBe("SOURCE_NOT_ACTIVE");
    registry.setEnabled("store_a", false);
    expect((await e.lookup("store_a", "x")).errorCode).toBe("CONNECTOR_DISABLED");
    expect(e.lookupCapableSlugs()).toEqual([]);
  });

  it("stays within the tracking share of the source rate limit", async () => {
    const c = new LookupDouble("store_a", async (_n, id) => listing("store_a", id));
    registry.register(c);
    sources = [source("store_a", { rateLimitPerMinute: 4 })];
    const e = exec({ trackingShare: 0.5 });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push(await e.lookup("store_a", `x${i}`));
    expect(statuses.map((r) => r.status)).toEqual([
      "FOUND",
      "FOUND",
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(statuses[2]!.retryAfterMs).toBeGreaterThan(0);
    expect(c.calls).toBe(2);
  });

  it("retries transient failures, then opens the circuit", async () => {
    const flaky = new LookupDouble("store_a", async (n, id) => {
      if (n === 1) throw new ConnectorError("NETWORK", "reset");
      return listing("store_a", id);
    });
    registry.register(flaky);
    const e = exec();
    expect(await e.lookup("store_a", "x")).toMatchObject({ status: "FOUND", attempts: 2 });

    const down = new LookupDouble("store_b", async () => {
      throw new ConnectorError("UPSTREAM", "503", { retryable: true });
    });
    registry.register(down);
    sources.push(source("store_b", { maxRetries: 0 }));
    expect((await e.lookup("store_b", "a")).status).toBe("FAILED");
    expect((await e.lookup("store_b", "b")).status).toBe("FAILED");
    expect(await e.lookup("store_b", "c")).toMatchObject({
      status: "FAILED",
      errorCode: "CIRCUIT_OPEN",
      retryable: true,
    });
    expect(down.calls).toBe(2);
  });

  it("times out a hung connector", async () => {
    registry.register(
      new LookupDouble(
        "store_a",
        (_n, _id, signal) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason as Error)),
          ),
      ),
    );
    sources = [source("store_a", { timeoutMs: 30, maxRetries: 0 })];
    expect(await exec().lookup("store_a", "x")).toMatchObject({
      status: "FAILED",
      errorCode: "TIMEOUT",
      retryable: true,
    });
  });
});
