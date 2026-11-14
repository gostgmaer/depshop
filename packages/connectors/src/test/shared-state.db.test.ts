/** Redis- and PostgreSQL-backed framework state (real local services; unique key prefix). */
import { randomBytes } from "node:crypto";
import { createPrismaClient, seedReferenceData, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryResponseCache,
  RedisResponseCache,
  requestFingerprint,
} from "../core/cache/response-cache.js";
import { ParallelSearchExecutor } from "../core/executor/executor.js";
import { HealthMonitor } from "../core/health/health-monitor.js";
import { RedisMetricsStore } from "../core/health/metrics.js";
import { MemoryRateLimiter, RedisRateLimiter } from "../core/rate-limiter/rate-limiter.js";
import {
  PrismaSourceConfigProvider,
  PrismaSourceStatusStore,
  effectiveStatus,
} from "../core/registry/source-config.js";
import { createDefaultRegistry } from "../default-registry.js";
import { seedMockSources } from "../mock/seed-mock-sources.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
let redis: Redis;
const prefix = `dmtest:${randomBytes(6).toString("hex")}`;

beforeAll(() => {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL required (pnpm infra:up)");
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
});
afterAll(async () => {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
  redis.disconnect();
  await prisma.$disconnect();
});
beforeEach(() => truncateAll(prisma));

describe("RedisRateLimiter", () => {
  it("shares one per-source budget across limiter instances (processes)", async () => {
    const a = new RedisRateLimiter(redis, prefix);
    const b = new RedisRateLimiter(redis, prefix);
    const results = await Promise.all([a, b, a, b, a].map((l) => l.acquire("src_x", 3)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect((await a.acquire("src_y", 3)).allowed).toBe(true); // per source
  });

  it("fails closed when Redis is unavailable", async () => {
    const broken = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    const errors: unknown[] = [];
    const d = await new RedisRateLimiter(broken, prefix, (e) => errors.push(e)).acquire("src", 10);
    expect(d.allowed).toBe(false);
    expect(errors).toHaveLength(1);
    broken.disconnect();
  });
});

describe("RedisResponseCache + RedisMetricsStore", () => {
  it("round-trips results with dates, honours TTL and invalidates per source", async () => {
    const cache = new RedisResponseCache(redis, prefix);
    const fp = requestFingerprint({ query: "acme", limit: 5, locale: "en-IN" });
    const now = new Date();
    const value = {
      sourceId: "mock_alpha",
      fetchedAt: now,
      rejectedItems: 0,
      items: [],
    };
    await cache.set("mock_alpha", fp, value, 30);
    expect(await cache.get("mock_alpha", fp)).toEqual(value);
    expect(await redis.ttl(`${prefix}:cache:v1:connector:mock_alpha:${fp}`)).toBeGreaterThan(25);
    await cache.set("mock_alpha", "nocache", value, 0); // TTL 0 = not cached
    expect(await cache.get("mock_alpha", "nocache")).toBeNull();
    await cache.invalidateSource("mock_alpha");
    expect(await cache.get("mock_alpha", fp)).toBeNull();
  });

  it("aggregates metrics across processes", async () => {
    const m = new RedisMetricsStore(redis, prefix);
    const at = new Date("2026-11-15T10:00:00Z");
    await m.record({
      sourceId: "s",
      outcome: "SUCCEEDED",
      durationMs: 100,
      resultCount: 4,
      cached: false,
      at,
    });
    await m.record({
      sourceId: "s",
      outcome: "TIMED_OUT",
      durationMs: 300,
      resultCount: 0,
      cached: false,
      errorCategory: "TIMEOUT",
      at,
    });
    await new RedisMetricsStore(redis, prefix).record({
      sourceId: "s",
      outcome: "SUCCEEDED",
      durationMs: 0,
      resultCount: 4,
      cached: true,
      at,
    });
    expect(await m.read("s")).toMatchObject({
      requests: 3,
      successes: 2,
      failures: 1,
      timeouts: 1,
      cacheHits: 1,
      results: 8,
      averageLatencyMs: 200,
      errorsByCategory: { TIMEOUT: 1 },
      lastSuccessAt: at.toISOString(),
      lastErrorCategory: "TIMEOUT",
    });
  });
});

describe("ShoppingSource-backed configuration and status", () => {
  it("drives eligibility from the database: only ACTIVE sources with ready connectors are searched", async () => {
    await seedReferenceData(prisma);
    await seedMockSources(prisma, "test");
    const registry = createDefaultRegistry({ NODE_ENV: "test" });
    const sources = new PrismaSourceConfigProvider(prisma, 0);
    const store = new PrismaSourceStatusStore(prisma);
    const executor = new ParallelSearchExecutor({
      registry,
      sources,
      rateLimiter: new MemoryRateLimiter(),
      cache: new MemoryResponseCache(),
      metrics: new RedisMetricsStore(redis, prefix),
      statusStore: store,
      allowMocks: true,
    });
    const run = await executor.run({ query: "acme nova" });
    expect(run.status).toBe("COMPLETED");
    const byId = Object.fromEntries(
      run.sources.map((s) => [s.sourceId, `${s.status}${s.errorCode ? `:${s.errorCode}` : ""}`]),
    );
    expect(byId).toEqual({
      amazon_in: "SKIPPED:SOURCE_NOT_ACTIVE",
      croma: "SKIPPED:SOURCE_NOT_ACTIVE",
      flipkart: "SKIPPED:SOURCE_NOT_ACTIVE",
      mock_alpha: "SUCCEEDED",
      mock_beta: "SUCCEEDED",
      reliance_digital: "SKIPPED:SOURCE_NOT_ACTIVE",
      tata_cliq: "SKIPPED:SOURCE_NOT_ACTIVE",
    });
    expect(run.items.length).toBeGreaterThan(0);
    expect(
      (await prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "mock_alpha" } }))
        .lastSuccessAt,
    ).not.toBeNull();

    // An admin activating Flipkart without credentials doesn't produce fake results.
    await prisma.shoppingSource.update({ where: { slug: "flipkart" }, data: { status: "ACTIVE" } });
    const again = await executor.run({ query: "acme nova" });
    expect(again.sources.find((s) => s.sourceId === "flipkart")).toMatchObject({
      status: "SKIPPED",
      errorCode: "NOT_CONFIGURED",
    });

    // …and the health monitor marks it FAILED with the reason.
    await new HealthMonitor(registry, sources, store).checkAll();
    const fk = await prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "flipkart" } });
    expect(effectiveStatus(fk.status, fk.health)).toBe("FAILED");
    expect(fk.lastHealthError).toMatch(/FLIPKART_AFFILIATE_ID/);
    const amazon = await prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "amazon_in" } });
    expect(effectiveStatus(amazon.status, amazon.health)).toBe("PENDING_APPROVAL");
  });

  it("refuses to create mock sources in production", async () => {
    await expect(seedMockSources(prisma, "production")).rejects.toThrow(/production/);
  });
});
