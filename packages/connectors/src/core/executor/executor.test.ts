/**
 * Connector framework tests with MOCK/SCRIPTED connectors only (fictional
 * data). Numbered describes map to the Phase 2.3 test list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MockConnector, ScriptedConnector } from "../../mock/mock-connector.js";
import {
  MemoryResponseCache,
  normalizeQuery,
  requestFingerprint,
} from "../cache/response-cache.js";
import { HealthMonitor } from "../health/health-monitor.js";
import { MemoryMetricsStore } from "../health/metrics.js";
import { MemoryRateLimiter } from "../rate-limiter/rate-limiter.js";
import { ConnectorRegistry } from "../registry/registry.js";
import type {
  SourceConfig,
  SourceHealthValue,
  SourceStatusStore,
} from "../registry/source-config.js";
import { CircuitBreakers } from "../retry/circuit-breaker.js";
import { backoffDelay } from "../retry/retry.js";
import { ConnectorError } from "../types/errors.js";
import type { ConnectorSearchResultInput, NormalizedProductInput } from "../types/schemas.js";
import { ParallelSearchExecutor, validateResult } from "./executor.js";

function source(slug: string, over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: `00000000-0000-7000-8000-${String(slug.length).padStart(12, "0")}`,
    slug,
    name: slug,
    status: "ACTIVE",
    isSample: true,
    timeoutMs: 200,
    rateLimitPerMinute: 1_000,
    maxRetries: 2,
    cacheTtlSeconds: 0,
    circuitFailureThreshold: 3,
    circuitOpenSeconds: 60,
    health: "UNKNOWN",
    ...over,
  };
}

function item(
  sourceId: string,
  over: Partial<NormalizedProductInput> = {},
): NormalizedProductInput {
  const now = new Date();
  return {
    sourceId,
    externalId: `${sourceId}-1`,
    title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
    brand: "Acme",
    productUrl: `https://${sourceId.replace(/_/g, "-")}.example.com/p/1`,
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

const ok = (id: string, items: unknown[] = [item(id)]): ConnectorSearchResultInput => ({
  sourceId: id,
  items,
  fetchedAt: new Date(),
});

let sources: SourceConfig[];
let registry: ConnectorRegistry;
let metrics: MemoryMetricsStore;
let cache: MemoryResponseCache;
let limiter: MemoryRateLimiter;
let clock: number;

function executor(over: Partial<ConstructorParameters<typeof ParallelSearchExecutor>[0]> = {}) {
  return new ParallelSearchExecutor({
    registry,
    sources: { list: async () => sources },
    rateLimiter: limiter,
    cache,
    metrics,
    allowMocks: true,
    random: () => 0, // deterministic backoff (0 ms)
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
    ...over,
  });
}

beforeEach(() => {
  sources = [];
  registry = new ConnectorRegistry();
  metrics = new MemoryMetricsStore();
  cache = new MemoryResponseCache();
  limiter = new MemoryRateLimiter();
  clock = 0;
});

describe("1. registration", () => {
  it("registers connectors by id, rejects duplicates and invalid ids, supports unregister", () => {
    registry.register(new MockConnector({ id: "mock_a", name: "A" }));
    expect(registry.get("mock_a")?.name).toBe("A");
    expect(() => registry.register(new MockConnector({ id: "mock_a", name: "again" }))).toThrow(
      /already/,
    );
    expect(() => registry.register(new MockConnector({ id: "Bad Id", name: "x" }))).toThrow(
      /Invalid/,
    );
    expect(registry.unregister("mock_a")).toBe(true);
    expect(registry.get("mock_a")).toBeUndefined();
  });
});

describe("2. discovery", () => {
  it("finds connectors by id and capability, and lists eligibility with reasons", () => {
    registry.register(new MockConnector({ id: "mock_a", name: "A" }));
    registry.register(
      new ScriptedConnector(
        "lookup_only",
        "L",
        async () => ok("lookup_only"),
        { state: "READY" },
        { search: false, productLookup: true },
      ),
    );
    registry.register(
      new ScriptedConnector(
        "phones",
        "P",
        async () => ok("phones"),
        { state: "READY" },
        { categories: ["smartphones"] },
      ),
    );
    expect(
      registry
        .byCapability((c) => c.productLookup)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["lookup_only", "mock_a"]);
    const { eligible, skipped } = registry.eligible(
      [source("mock_a"), source("lookup_only"), source("phones"), source("unknown")],
      { query: "shoes", limit: 5, locale: "en-IN", category: "footwear" },
      { allowMocks: true },
    );
    expect(eligible.map((e) => e.connector.id)).toEqual(["mock_a"]);
    expect(Object.fromEntries(skipped.map((s) => [s.source.slug, s.reason]))).toEqual({
      lookup_only: "NO_SEARCH_CAPABILITY",
      phones: "CATEGORY_NOT_SUPPORTED",
      unknown: "NO_CONNECTOR",
    });
  });
});

describe("3. parallel execution", () => {
  it("searches all eligible sources concurrently within the concurrency bound", async () => {
    let active = 0;
    let peak = 0;
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
      registry.register(
        new ScriptedConnector(id, id, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 30));
          active -= 1;
          return ok(id);
        }),
      );
      sources.push(source(id));
    }
    const started = Date.now();
    const run = await executor({ concurrency: 3 }).run({ query: "nova phone" });
    const elapsed = Date.now() - started;
    expect(run.status).toBe("COMPLETED");
    expect(run.sources.every((s) => s.status === "SUCCEEDED" && s.resultCount === 1)).toBe(true);
    expect(run.items).toHaveLength(6);
    expect(peak).toBe(3); // bounded
    expect(elapsed).toBeLessThan(6 * 30); // but parallel, not sequential
  });

  it("works end-to-end with the mock stores (fictional data, provenance MOCK)", async () => {
    registry.register(new MockConnector({ id: "mock_alpha", name: "Alpha" }));
    registry.register(new MockConnector({ id: "mock_beta", name: "Beta", priceFactorBp: 9_700 }));
    sources.push(source("mock_alpha"), source("mock_beta"));
    const run = await executor().run({ query: "acme nova", maxPricePaise: 2_000_000 });
    expect(run.status).toBe("COMPLETED");
    expect(
      run.items.every(
        (i) => i.provenance.method === "MOCK" && i.productUrl.includes("example.com"),
      ),
    ).toBe(true);
    const prices = run.items
      .filter((i) => i.title.includes("128GB"))
      .map((i) => [i.sourceId, i.sellingPricePaise]);
    expect(prices).toEqual([
      ["mock_alpha", 1_899_900],
      ["mock_beta", 1_842_903],
    ]);
  });
});

describe("4. timeouts", () => {
  it("times out a slow source (abort signal fired) without delaying the others", async () => {
    let aborted = false;
    registry.register(
      new ScriptedConnector("slow", "slow", (_c, _r, ctx) => {
        ctx.signal.addEventListener("abort", () => (aborted = true));
        return new Promise(() => undefined); // never resolves, ignores the signal
      }),
    );
    registry.register(new ScriptedConnector("fast", "fast", async () => ok("fast")));
    sources.push(source("slow", { timeoutMs: 50, maxRetries: 0 }), source("fast"));
    const run = await executor().run({ query: "nova" });
    const slow = run.sources.find((s) => s.sourceId === "slow")!;
    expect(slow).toMatchObject({ status: "TIMED_OUT", errorCode: "TIMEOUT" });
    expect(slow.durationMs).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(run.status).toBe("PARTIAL");
    expect(run.items.map((i) => i.sourceId)).toEqual(["fast"]);
    expect((await metrics.read("slow")).timeouts).toBe(1);
  });
});

describe("5. retries", () => {
  it("retries retryable failures with backoff and succeeds", async () => {
    const c = new ScriptedConnector("flaky", "f", async (call) => {
      if (call < 3) throw new ConnectorError("UPSTREAM", "503 from upstream");
      return ok("flaky");
    });
    registry.register(c);
    sources.push(source("flaky", { maxRetries: 2 }));
    const run = await executor().run({ query: "nova" });
    expect(run.sources[0]).toMatchObject({ status: "SUCCEEDED", attempts: 3 });
    expect(c.calls).toBe(3);
  });

  it("does not retry non-retryable errors (auth, invalid response)", async () => {
    const c = new ScriptedConnector("auth", "a", async () => {
      throw new ConnectorError("AUTH", "401");
    });
    registry.register(c);
    sources.push(source("auth", { maxRetries: 5 }));
    const run = await executor().run({ query: "nova" });
    expect(run.sources[0]).toMatchObject({ status: "FAILED", errorCode: "AUTH", attempts: 1 });
    expect(c.calls).toBe(1);
  });

  it("uses exponential backoff with full jitter, capped", () => {
    const policy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 1_000 };
    expect([0, 1, 2, 3, 4].map((n) => backoffDelay(n, policy, () => 0.999))).toEqual([
      99, 199, 399, 799, 999,
    ]);
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
  });
});

describe("6. circuit breaker", () => {
  it("opens after N failures, skips the source while open, probes after the open period, closes on success", async () => {
    let fail = true;
    const c = new ScriptedConnector("cb", "cb", async () => {
      if (fail) throw new ConnectorError("UPSTREAM", "down");
      return ok("cb");
    });
    registry.register(c);
    sources.push(
      source("cb", { maxRetries: 0, circuitFailureThreshold: 2, circuitOpenSeconds: 10 }),
    );
    const transitions: string[] = [];
    const breakers = new CircuitBreakers(
      () => clock,
      (_id, from, to) => transitions.push(`${from}->${to}`),
    );
    const ex = executor({ breakers, now: () => clock });
    await ex.run({ query: "nova a" });
    await ex.run({ query: "nova b" });
    expect(c.calls).toBe(2);
    const open = await ex.run({ query: "nova c" });
    expect(open.sources[0]).toMatchObject({ status: "FAILED", errorCode: "CIRCUIT_OPEN" });
    expect(c.calls).toBe(2); // not called while open
    clock += 10_000;
    fail = false;
    const probe = await ex.run({ query: "nova d" });
    expect(probe.sources[0]?.status).toBe("SUCCEEDED");
    expect(transitions).toEqual(["CLOSED->OPEN", "OPEN->HALF_OPEN", "HALF_OPEN->CLOSED"]);
  });

  it("re-opens when the half-open probe fails", () => {
    const b = new CircuitBreakers(() => clock);
    const s = { failureThreshold: 1, openMs: 1_000 };
    b.recordFailure("x", s);
    expect(b.tryAcquire("x", s)).toBe(false);
    clock += 1_000;
    expect(b.tryAcquire("x", s)).toBe(true); // probe
    expect(b.tryAcquire("x", s)).toBe(false); // only one probe
    b.recordFailure("x", s);
    expect(b.state("x", s)).toBe("OPEN");
  });
});

describe("7. partial results", () => {
  it("keeps successful sources' results when others fail in different ways", async () => {
    registry.register(new ScriptedConnector("good", "g", async () => ok("good")));
    registry.register(
      new ScriptedConnector("boom", "b", async () => {
        throw new Error("unexpected crash");
      }),
    );
    registry.register(new ScriptedConnector("bad", "x", async () => ({ nonsense: true }) as never));
    sources.push(source("good"), source("boom"), source("bad"));
    const run = await executor().run({ query: "nova" });
    expect(run.status).toBe("PARTIAL");
    expect(run.items.map((i) => i.sourceId)).toEqual(["good"]);
    expect(
      Object.fromEntries(run.sources.map((s) => [s.sourceId, [s.status, s.errorCode ?? null]])),
    ).toEqual({
      good: ["SUCCEEDED", null],
      boom: ["FAILED", "UNKNOWN"],
      bad: ["FAILED", "INVALID_RESPONSE"],
    });
  });

  it("reports FAILED when every source fails and NO_SOURCES when nothing is eligible", async () => {
    registry.register(
      new ScriptedConnector("down", "d", async () => {
        throw new ConnectorError("AUTH", "no");
      }),
    );
    sources.push(source("down"));
    expect((await executor().run({ query: "nova" })).status).toBe("FAILED");
    sources = [source("down", { status: "PENDING_CREDENTIALS" })];
    const none = await executor().run({ query: "nova" });
    expect(none.status).toBe("NO_SOURCES");
    expect(none.items).toEqual([]);
    expect(none.sources[0]).toMatchObject({ status: "SKIPPED", errorCode: "SOURCE_NOT_ACTIVE" });
  });
});

describe("8. rate limiting", () => {
  it("enforces the per-source limit and fails RATE_LIMITED when the wait doesn't fit", async () => {
    const c = new ScriptedConnector("rl", "rl", async () => ok("rl"));
    registry.register(c);
    sources.push(source("rl", { rateLimitPerMinute: 2 }));
    const ex = executor({ maxRateLimitWaitMs: 10 });
    const runs = [];
    for (const q of ["nova a", "nova b", "nova c"]) runs.push(await ex.run({ query: q }));
    expect(runs.map((r) => r.sources[0]?.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "FAILED"]);
    expect(runs[2]?.sources[0]?.errorCode).toBe("RATE_LIMITED");
    expect(c.calls).toBe(2);
    const m = await metrics.read("rl");
    expect(m.rateLimitEvents).toBe(1);
    // Our own limiter rejecting a call does not count against the circuit.
    expect(ex.circuitBreakers.state("rl", { failureThreshold: 1, openMs: 1 })).toBe("CLOSED");
  });

  it("waits for the window when it fits within the budget", async () => {
    let calls = 0;
    const slept: number[] = [];
    const fakeLimiter = {
      acquire: async () =>
        calls++ === 0 ? { allowed: false, retryAfterMs: 5 } : { allowed: true, retryAfterMs: 0 },
    };
    registry.register(new ScriptedConnector("w", "w", async () => ok("w")));
    sources.push(source("w"));
    const run = await executor({
      rateLimiter: fakeLimiter,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).run({ query: "nova" });
    expect(run.sources[0]?.status).toBe("SUCCEEDED");
    expect(slept).toEqual([5]);
  });

  it("memory limiter uses fixed one-minute windows per source", async () => {
    let t = 0;
    const l = new MemoryRateLimiter(() => t);
    expect((await l.acquire("a", 1)).allowed).toBe(true);
    expect(await l.acquire("a", 1)).toEqual({ allowed: false, retryAfterMs: 60_000 });
    expect((await l.acquire("b", 1)).allowed).toBe(true);
    t = 60_000;
    expect((await l.acquire("a", 1)).allowed).toBe(true);
  });
});

describe("9. response normalization", () => {
  it("returns validated items with paise prices, promotions kept apart from the price", async () => {
    registry.register(new MockConnector({ id: "mock_alpha", name: "Alpha" }));
    sources.push(source("mock_alpha"));
    const run = await executor().run({ query: "mixer grinder" });
    const mixer = run.items[0]!;
    expect(mixer).toMatchObject({
      title: "Acme PowerMix 750W Mixer Grinder",
      sellingPricePaise: 329_900,
      mrpPaise: 499_900,
      shippingPaise: 4_000,
      priceType: "LISTED",
      currency: "INR",
    });
    expect(mixer.promotions[0]).toMatchObject({ type: "BANK_OFFER", percentBasisPoints: 1_000 });
    expect(mixer.observedAt).toBeInstanceOf(Date);
  });

  it("normalizes queries so equivalent requests share a fingerprint", () => {
    expect(normalizeQuery("  Acme   NOVA ７ ")).toBe("acme nova 7");
    const base = { query: "Acme Nova", limit: 20, locale: "en-IN" as const };
    expect(requestFingerprint({ ...base, query: "  acme   nova " })).toBe(requestFingerprint(base));
    expect(requestFingerprint({ ...base, brands: ["B", "a"] })).toBe(
      requestFingerprint({ ...base, brands: ["a", "b"] }),
    );
    expect(requestFingerprint({ ...base, maxPricePaise: 1 })).not.toBe(requestFingerprint(base));
  });
});

describe("10. invalid response rejection", () => {
  it("drops invalid items individually and rejects malformed or foreign envelopes", () => {
    const good = item("s");
    const result = validateResult(
      {
        sourceId: "s",
        fetchedAt: new Date(),
        items: [
          good,
          { ...good, externalId: "neg", sellingPricePaise: -5 },
          { ...good, externalId: "float", sellingPricePaise: 19.99 },
          { ...good, externalId: "js", productUrl: "javascript:alert(1)" },
          { ...good, externalId: "usd", currency: "USD" },
          { ...good, externalId: "other", sourceId: "someone_else" },
          { ...good, externalId: "snippet", priceType: "INDICATIVE" }, // only discovery may be indicative
          { ...good, externalId: "extra", secret: "x" },
        ],
      },
      "s",
      20,
    );
    expect(result.items.map((i) => i.externalId)).toEqual(["s-1"]);
    expect(result.rejectedItems).toBe(7);
    expect(() => validateResult({ items: "nope" }, "s", 20)).toThrow(/Malformed/);
    expect(() =>
      validateResult({ sourceId: "x", items: [], fetchedAt: new Date() }, "s", 20),
    ).toThrow(/claims/);
  });
});

describe("11. duplicate request prevention", () => {
  it("shares one upstream call between identical concurrent searches, then serves the cache", async () => {
    const c = new ScriptedConnector("dd", "dd", async () => {
      await new Promise((r) => setTimeout(r, 30));
      return ok("dd");
    });
    registry.register(c);
    sources.push(source("dd", { cacheTtlSeconds: 60 }));
    const ex = executor();
    const runs = await Promise.all([
      ex.run({ query: "Acme Nova" }),
      ex.run({ query: "  acme   nova " }),
      ex.run({ query: "ACME NOVA" }),
    ]);
    expect(c.calls).toBe(1);
    expect(runs.filter((r) => r.sources[0]?.deduplicated).length).toBe(2);
    expect(runs.every((r) => r.items.length === 1)).toBe(true);
    const later = await ex.run({ query: "acme nova" });
    expect(later.sources[0]?.cached).toBe(true);
    expect(c.calls).toBe(1);
    expect((await metrics.read("dd")).cacheHits).toBe(1);
    await cache.invalidateSource("dd");
    await ex.run({ query: "acme nova" });
    expect(c.calls).toBe(2);
  });
});

describe("12. health reporting", () => {
  it("records health per connector; unconfigured ACTIVE sources are DOWN with the reason, no network call", async () => {
    const recorded: Record<string, [SourceHealthValue, string | null]> = {};
    const successes: string[] = [];
    const store: SourceStatusStore = {
      recordHealth: async (slug, h, err) => {
        recorded[slug] = [h, err];
      },
      recordSuccess: async (slug) => {
        successes.push(slug);
      },
    };
    registry.register(new MockConnector({ id: "mock_alpha", name: "Alpha" }));
    registry.register(
      new ScriptedConnector("nocreds", "n", async () => ok("nocreds"), {
        state: "PENDING_CREDENTIALS",
        missing: ["API_KEY"],
      }),
    );
    registry.register(
      new ScriptedConnector("pending", "p", async () => ok("pending"), {
        state: "PENDING_APPROVAL",
        reason: "partner agreement",
      }),
    );
    const broken = new ScriptedConnector("broken", "b", async () => ok("broken"));
    broken.getHealth = async () => {
      throw new ConnectorError("UPSTREAM", "503");
    };
    registry.register(broken);
    sources = [
      source("mock_alpha"),
      source("nocreds"),
      source("pending", { status: "PENDING_APPROVAL" }),
      source("broken"),
    ];
    const reports = await new HealthMonitor(
      registry,
      { list: async () => sources },
      store,
    ).checkAll();
    expect(reports).toHaveLength(4);
    expect(recorded).toEqual({
      mock_alpha: ["HEALTHY", null],
      nocreds: ["DOWN", "Credentials not configured: API_KEY"],
      pending: ["UNKNOWN", "partner agreement"],
      broken: ["DOWN", "503"],
    });
    expect(successes).toEqual(["mock_alpha"]);
  });
});

describe("13. disabled connector exclusion", () => {
  it("never calls disabled, pending, unconfigured, killed or (when not allowed) mock connectors", async () => {
    const calls: string[] = [];
    const mk = (id: string, readiness?: ConstructorParameters<typeof ScriptedConnector>[3]) =>
      new ScriptedConnector(
        id,
        id,
        async () => {
          calls.push(id);
          return ok(id);
        },
        readiness,
      );
    registry.register(mk("live"));
    registry.register(mk("off"));
    registry.register(mk("maint"));
    registry.register(mk("killed"));
    registry.register(mk("nocreds", { state: "PENDING_CREDENTIALS", missing: ["TOKEN"] }));
    registry.register(new MockConnector({ id: "mock_alpha", name: "Alpha" }));
    registry.setEnabled("killed", false);
    sources = [
      source("live"),
      source("off", { status: "DISABLED" }),
      source("maint", { status: "MAINTENANCE" }),
      source("killed"),
      source("nocreds"),
      source("mock_alpha"),
    ];
    const run = await executor({ allowMocks: false }).run({ query: "nova" });
    expect(calls).toEqual(["live"]);
    expect(
      Object.fromEntries(run.sources.map((s) => [s.sourceId, s.errorCode ?? s.status])),
    ).toEqual({
      live: "SUCCEEDED",
      off: "SOURCE_NOT_ACTIVE",
      maint: "SOURCE_NOT_ACTIVE",
      killed: "CONNECTOR_DISABLED",
      nocreds: "NOT_CONFIGURED",
      mock_alpha: "MOCK_NOT_ALLOWED",
    });
    // A user filter limits the search to the chosen sources.
    calls.length = 0;
    registry.setEnabled("killed", true);
    await executor().run({ query: "nova" }, { only: ["killed"] });
    expect(calls).toEqual(["killed"]);
  });
});
