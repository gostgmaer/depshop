/**
 * Load test (NOT part of test:db): `pnpm --filter @dealmind/worker test:load`.
 *
 * Price tracking + alert evaluation through REAL BullMQ queues and workers on
 * real PostgreSQL/Redis, with production concurrency. Marketplaces are a
 * scripted MOCK connector with configurable latency (never live sources).
 *
 *   LOAD_OFFERS (default 400)       tracked offers (2 alerts each, 50 users)
 *   LOAD_UPSTREAM_MS (default 80)   simulated marketplace latency per lookup
 *   LOAD_CONCURRENCY (default 8)    worker concurrency (= PRICE_TRACKING_CONCURRENCY default)
 *
 * Every offer's price drops below the alerts' target, so each refresh records a
 * check + snapshot and enqueues an evaluation that triggers two alerts. Results
 * are written to load/results/worker-tracking.json.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConnectorRegistry,
  MemoryMetricsStore,
  MemoryRateLimiter,
  type NormalizedProductInput,
  PrismaSourceConfigProvider,
  ProductLookupExecutor,
  type ShoppingConnector,
  seedMockSources,
} from "@dealmind/connectors";
import { createPrismaClient, seedReferenceData, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { redisConnectionFromUrl } from "@dealmind/queue";
import { type Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { processAlertEvaluation } from "../../processors/alert-evaluation.processor.js";
import { processPriceRefresh } from "../../processors/price-refresh.processor.js";
import { TrackingMetrics } from "../../services/tracking-metrics.js";

const OFFERS = Number(process.env.LOAD_OFFERS ?? 400);
const UPSTREAM_MS = Number(process.env.LOAD_UPSTREAM_MS ?? 80);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 8);
const USERS = 50;

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
const redisUrl = process.env.REDIS_URL!;
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
const prefix = `dmload${randomUUID().slice(0, 8)}`;
const connection = redisConnectionFromUrl(redisUrl);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted marketplace (fictional "Acme" data) with fixed latency. */
class MockMarketplace implements ShoppingConnector {
  readonly isMock = false;
  constructor(
    readonly id: string,
    readonly name = id,
  ) {}
  getCapabilities() {
    return {
      search: true,
      productLookup: true,
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
  async getProduct(externalId: string): Promise<NormalizedProductInput> {
    await sleep(UPSTREAM_MS);
    const now = new Date();
    return {
      sourceId: this.id,
      externalId,
      title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
      brand: "Acme",
      productUrl: `https://${this.id.replace(/_/g, "-")}.example.com/p/${externalId}`,
      sellingPricePaise: 1_900_000, // below every alert's 2_000_000 target
      mrpPaise: 2_500_000,
      shippingPaise: 0,
      priceType: "LISTED",
      currency: "INR",
      stockStatus: "IN_STOCK",
      observedAt: now,
      provenance: { method: "MOCK", provider: "load-test", retrievedAt: now },
    };
  }
  async getHealth() {
    return { status: "HEALTHY" as const, checkedAt: new Date() };
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};
const queues: Queue[] = [];
const workers: Worker[] = [];
const offerIds: string[] = [];

beforeAll(async () => {
  await truncateAll(prisma);
  await seedReferenceData(prisma);
  await seedMockSources(prisma, "test");
  await prisma.shoppingSource.updateMany({
    data: {
      status: "ACTIVE",
      trackingEnabled: true,
      rateLimitPerMinute: 1_000_000,
      cacheTtlSeconds: 0,
      maxRetries: 0,
    },
  });
  const sources = await prisma.shoppingSource.findMany({
    where: { slug: { in: ["mock_alpha", "mock_beta"] } },
  });
  const users = await Promise.all(
    Array.from({ length: USERS }, (_, i) =>
      prisma.user.create({
        data: {
          email: `load-${i}-${prefix}@example.com`,
          name: `Load ${i}`,
          iamUserId: randomUUID(),
        },
      }),
    ),
  );
  const observedAt = new Date(Date.now() - 3_600_000);
  for (let i = 0; i < OFFERS; i++) {
    const product = await prisma.product.create({
      data: { name: `Acme Nova ${i}`, normalizedName: `acme nova ${i}`, brand: "Acme" },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, variantKey: `v${i}` },
    });
    const src = sources[i % sources.length]!;
    const o = await prisma.productOffer.create({
      data: {
        productId: product.id,
        variantId: variant.id,
        sourceId: src.id,
        externalId: `${src.slug}-sku-${i}`,
        productUrl: `https://example.com/${src.slug}-sku-${i}`,
        title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
        sellingPricePaise: 2_100_000n,
        mrpPaise: 2_500_000n,
        shippingPaise: 0n,
        stockStatus: "IN_STOCK",
        observedAt,
      },
    });
    await prisma.priceSnapshot.create({
      data: {
        offerId: o.id,
        sellingPricePaise: 2_100_000n,
        mrpPaise: 2_500_000n,
        shippingPaise: 0n,
        stockStatus: "IN_STOCK",
        observedAt,
      },
    });
    for (const k of [0, 1])
      await prisma.priceAlert.create({
        data: {
          userId: users[(i * 2 + k) % USERS]!.id,
          variantId: variant.id,
          sourceId: k === 0 ? null : src.id,
          type: "TARGET_PRICE",
          targetPricePaise: 2_000_000n,
        },
      });
    offerIds.push(o.id);
  }
}, 600_000);

afterAll(async () => {
  for (const w of workers) await w.close();
  for (const q of queues) await q.obliterate({ force: true }).catch(() => undefined);
  for (const q of queues) await q.close();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
  redis.disconnect();
  await prisma.$disconnect();
});

it(`refreshes ${OFFERS} offers and evaluates ${OFFERS * 2} alerts through BullMQ`, async () => {
  const bull = { connection, prefix: `${prefix}:bull` };
  const refreshQ = new Queue("load-price-refresh", bull);
  const alertQ = new Queue("load-alert-evaluation", bull);
  queues.push(refreshQ, alertQ);
  const registry = new ConnectorRegistry()
    .register(new MockMarketplace("mock_alpha"))
    .register(new MockMarketplace("mock_beta"));
  const lookup = new ProductLookupExecutor({
    registry,
    sources: new PrismaSourceConfigProvider(prisma, 0),
    rateLimiter: new MemoryRateLimiter(),
    metrics: new MemoryMetricsStore(),
    retry: { baseDelayMs: 50, maxDelayMs: 500 },
    trackingShare: 1,
  });
  const metrics = new TrackingMetrics(redis, prefix);
  let deliveries = 0;
  const refreshDur: number[] = [];
  const alertDur: number[] = [];
  const timeOf = (j: Job) => (j.finishedOn ?? 0) - (j.processedOn ?? 0);

  const refreshWorker = new Worker(
    "load-price-refresh",
    async (job) =>
      processPriceRefresh(
        {
          prisma,
          lookup,
          metrics,
          enqueueAlertEvaluation: async (checkId) => {
            await alertQ.add(
              "evaluate",
              { checkId },
              { jobId: `alerts.${checkId}`, removeOnComplete: true },
            );
          },
        },
        job.data as { offerId: string; slot: string },
        { attempt: job.attemptsMade + 1, maxAttempts: 3 },
      ),
    { ...bull, concurrency: CONCURRENCY },
  );
  const alertWorker = new Worker(
    "load-alert-evaluation",
    async (job) =>
      processAlertEvaluation(
        { prisma, metrics, enqueueDelivery: async () => void (deliveries += 1) },
        job.data as { checkId: string },
      ),
    { ...bull, concurrency: CONCURRENCY },
  );
  workers.push(refreshWorker, alertWorker);
  refreshWorker.on("completed", (j) => refreshDur.push(timeOf(j)));
  alertWorker.on("completed", (j) => alertDur.push(timeOf(j)));
  let failed = 0;
  refreshWorker.on("failed", () => (failed += 1));
  alertWorker.on("failed", () => (failed += 1));

  const slot = new Date().toISOString().slice(0, 16);
  const t0 = Date.now();
  await refreshQ.addBulk(
    offerIds.map((offerId) => ({
      name: "refresh",
      data: { offerId, slot },
      opts: {
        jobId: `refresh.${offerId}.${slot.replace(/:/g, "-")}`,
        attempts: 3,
        removeOnComplete: true,
      },
    })),
  );
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (refreshDur.length + failed >= OFFERS && alertDur.length >= refreshDur.length) break;
    await sleep(200);
  }
  const wallMs = Date.now() - t0;

  const [checks, evaluations, triggered, notifications] = await Promise.all([
    prisma.priceCheck.count(),
    prisma.alertEvaluation.count(),
    prisma.priceAlert.count({ where: { status: "TRIGGERED" } }),
    prisma.notification.count(),
  ]);
  const result = {
    scenario: "price-refresh + alert-evaluation via BullMQ",
    offers: OFFERS,
    alerts: OFFERS * 2,
    upstreamLatencyMs: UPSTREAM_MS,
    concurrency: CONCURRENCY,
    wallSeconds: Math.round(wallMs / 100) / 10,
    refreshJobsPerSecond: Math.round((refreshDur.length / wallMs) * 10_000) / 10,
    refreshJobMs: { p50: pct(refreshDur, 50), p95: pct(refreshDur, 95), p99: pct(refreshDur, 99) },
    alertJobsPerSecond: Math.round((alertDur.length / wallMs) * 10_000) / 10,
    alertJobMs: { p50: pct(alertDur, 50), p95: pct(alertDur, 95), p99: pct(alertDur, 99) },
    failedJobs: failed,
    database: {
      priceChecks: checks,
      alertEvaluations: evaluations,
      alertsTriggered: triggered,
      notifications,
    },
    queuedDeliveries: deliveries,
  };
  const out = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../load/results",
  );
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "worker-tracking.json"), JSON.stringify(result, null, 2));
  console.warn(JSON.stringify(result, null, 2));

  expect(failed).toBe(0);
  expect(refreshDur.length).toBe(OFFERS);
  expect(checks).toBe(OFFERS);
  expect(triggered).toBe(OFFERS * 2); // every alert fired exactly once
}, 600_000);
