/**
 * Global price tracking against real PostgreSQL, Redis and BullMQ, with a
 * scripted marketplace connector (fictional "Acme" data). Numbered describes
 * map to the Phase 5.1 test list.
 */
import { randomUUID } from "node:crypto";
import {
  ConnectorRegistry,
  MemoryMetricsStore,
  MemoryRateLimiter,
  type NormalizedProductInput,
  PrismaSourceConfigProvider,
  ProductLookupExecutor,
  type ShoppingConnector,
  ConnectorError,
  seedMockSources,
} from "@dealmind/connectors";
import { createPrismaClient, seedReferenceData, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { QueueName, priceRefreshJob, redisConnectionFromUrl } from "@dealmind/queue";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processAlertEvaluation } from "../processors/alert-evaluation.processor.js";
import type { EmailMessage } from "@dealmind/notifications";
import { processNotificationDelivery } from "../processors/notification.processor.js";
import {
  processPriceRefresh,
  type PriceRefreshDeps,
} from "../processors/price-refresh.processor.js";
import { runCleanup } from "../schedulers/cleanup.scheduler.js";
import { scheduleDueOffers } from "../schedulers/tracking.scheduler.js";
import { TrackingMetrics } from "../services/tracking-metrics.js";
import { createTrackedWorker } from "../workers/tracked-worker.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const redisUrl = process.env.REDIS_URL!;
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
const prefix = `dmtrack${randomUUID().slice(0, 8)}`;
const connection = redisConnectionFromUrl(redisUrl);
const bullPrefix = `${prefix}:bull`;
const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

// ── Scripted marketplace ──
type Listing = Partial<NormalizedProductInput> & { gone?: boolean; fail?: number };
class Marketplace implements ShoppingConnector {
  calls = new Map<string, number>();
  listings = new Map<string, Listing>();
  failuresLeft = new Map<string, number>();
  readonly isMock = false;
  constructor(
    readonly id: string,
    readonly name = id,
  ) {}
  total() {
    return [...this.calls.values()].reduce((a, b) => a + b, 0);
  }
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
  async getProduct(externalId: string): Promise<NormalizedProductInput | null> {
    this.calls.set(externalId, (this.calls.get(externalId) ?? 0) + 1);
    const left = this.failuresLeft.get(externalId) ?? 0;
    if (left > 0) {
      this.failuresLeft.set(externalId, left - 1);
      throw new ConnectorError("UPSTREAM", "503 from marketplace", { retryable: true });
    }
    const l = this.listings.get(externalId);
    if (!l || l.gone) return null;
    const now = new Date();
    return {
      sourceId: this.id,
      externalId,
      title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
      brand: "Acme",
      productUrl: `https://${this.id.replace(/_/g, "-")}.example.com/p/${externalId}`,
      sellingPricePaise: 2_000_000,
      mrpPaise: 2_500_000,
      shippingPaise: 0,
      priceType: "LISTED",
      currency: "INR",
      stockStatus: "IN_STOCK",
      observedAt: now,
      provenance: { method: "MOCK", provider: "test", retrievedAt: now },
      ...l,
    };
  }
  async getHealth() {
    return { status: "HEALTHY" as const, checkedAt: new Date() };
  }
}

let alpha: Marketplace;
let beta: Marketplace;
let lookup: ProductLookupExecutor;
let metrics: TrackingMetrics;
let limiter: MemoryRateLimiter;
let clock: Date;
const queues: Queue[] = [];
const workers: Worker[] = [];
const enqueuedChecks: string[] = [];
const enqueuedDeliveries: string[] = [];

function refreshDeps(over: Partial<PriceRefreshDeps> = {}): PriceRefreshDeps {
  return {
    prisma,
    lookup,
    metrics,
    enqueueAlertEvaluation: async (id) => void enqueuedChecks.push(id),
    now: () => clock,
    random: () => 0.5,
    ...over,
  };
}
const refresh = (offerId: string, attempt = 1, maxAttempts = 1) =>
  processPriceRefresh(refreshDeps(), { offerId }, { attempt, maxAttempts });
const evaluate = (checkId: string) =>
  processAlertEvaluation(
    {
      prisma,
      metrics,
      enqueueDelivery: async (id) => void enqueuedDeliveries.push(id),
      now: () => clock,
    },
    { checkId },
  );

async function sourceId(slug: string) {
  return (await prisma.shoppingSource.findUniqueOrThrow({ where: { slug } })).id;
}

let seq = 0;
async function offer(slug: string, over: Record<string, unknown> = {}, price = 2_100_000) {
  seq += 1;
  const product = await prisma.product.create({
    data: { name: `Acme Nova ${seq}`, normalizedName: `acme nova ${seq}`, brand: "Acme" },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, variantKey: `v${seq}` },
  });
  const externalId = `${slug}-sku-${seq}`;
  const o = await prisma.productOffer.create({
    data: {
      productId: product.id,
      variantId: variant.id,
      sourceId: await sourceId(slug),
      externalId,
      productUrl: `https://example.com/${externalId}`,
      title: "Acme Nova 7 5G (8GB RAM, 128GB Storage)",
      sellingPricePaise: BigInt(price),
      mrpPaise: 2_500_000n,
      shippingPaise: 0n,
      stockStatus: "IN_STOCK",
      observedAt: new Date(clock.getTime() - 3_600_000),
      ...over,
    },
  });
  await prisma.priceSnapshot.create({
    data: {
      offerId: o.id,
      sellingPricePaise: BigInt(price),
      mrpPaise: 2_500_000n,
      shippingPaise: 0n,
      stockStatus: "IN_STOCK",
      observedAt: new Date(clock.getTime() - 3_600_000),
    },
  });
  (slug === "mock_alpha" ? alpha : beta).listings.set(externalId, { sellingPricePaise: price });
  return o;
}

async function user(n: number, prefs?: { notifyEmail?: boolean; notifyInApp?: boolean }) {
  const u = await prisma.user.create({
    data: { email: `t${n}-${seq}@example.com`, name: `User ${n}`, iamUserId: randomUUID() },
  });
  if (prefs) await prisma.userPreference.create({ data: { userId: u.id, ...prefs } });
  return u;
}

const alert = (userId: string, variantId: string, over: Record<string, unknown> = {}) =>
  prisma.priceAlert.create({
    data: { userId, variantId, type: "TARGET_PRICE", targetPricePaise: 2_000_000n, ...over },
  });

function queue(name: string) {
  const q = new Queue(name, { connection, prefix: bullPrefix });
  queues.push(q);
  return q;
}

beforeAll(async () => {
  await truncateAll(prisma);
  await seedReferenceData(prisma);
  await seedMockSources(prisma, "test");
});

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

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AlertEvaluation", "PriceCheck", "NotificationDelivery", "Notification", "PriceAlert",
     "WatchlistItem", "Watchlist", "UserPreference", "PriceSnapshot", "ProductOffer", "ProductVariant",
     "Product", "User" CASCADE`,
  );
  await prisma.shoppingSource.updateMany({
    data: {
      status: "ACTIVE",
      trackingEnabled: true,
      rateLimitPerMinute: 1_000,
      cacheTtlSeconds: 0,
      maxRetries: 0,
    },
  });
  clock = new Date("2026-11-16T10:00:00Z");
  alpha = new Marketplace("mock_alpha", "Mock Store Alpha");
  beta = new Marketplace("mock_beta", "Mock Store Beta");
  const registry = new ConnectorRegistry().register(alpha).register(beta);
  limiter = new MemoryRateLimiter();
  lookup = new ProductLookupExecutor({
    registry,
    sources: new PrismaSourceConfigProvider(prisma, 0),
    rateLimiter: limiter,
    metrics: new MemoryMetricsStore(),
    random: () => 0,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    trackingShare: 1,
  });
  metrics = new TrackingMetrics(redis, prefix, () => clock);
  enqueuedChecks.length = 0;
  enqueuedDeliveries.length = 0;
});

afterEach(async () => {
  for (const w of workers.splice(0)) await w.close();
});

describe("1–3. global scheduler: eligible offers, priority, no duplicates", () => {
  it("enqueues each due offer once, prioritized by shared demand, and leases it", async () => {
    const q = queue(`pr-${randomUUID()}`);
    const hot = await offer("mock_alpha");
    const cold = await offer("mock_beta");
    // Not eligible:
    await offer("mock_alpha", { trackingState: "EXPIRED" });
    await offer("mock_alpha", { nextCheckAt: new Date(clock.getTime() + 60_000) });
    await offer("mock_alpha", { trackedUntil: new Date(clock.getTime() - 1) });
    for (let i = 0; i < 3; i += 1) await alert((await user(i)).id, hot.variantId);

    const deps = {
      prisma,
      queue: q,
      redis,
      redisPrefix: prefix,
      metrics,
      capableSlugs: () => lookup.lookupCapableSlugs(),
      now: () => clock,
    };
    // Two scheduler ticks at once (e.g. two worker processes): each offer is claimed once.
    const [a, b] = await Promise.all([scheduleDueOffers(deps), scheduleDueOffers(deps)]);
    expect(a.enqueued + b.enqueued).toBe(2);
    const jobs = await q.getJobs(["prioritized", "waiting"]);
    expect(jobs.map((j) => (j.data as { offerId: string }).offerId).sort()).toEqual(
      [hot.id, cold.id].sort(),
    );
    const byId = Object.fromEntries(jobs.map((j) => [(j.data as { offerId: string }).offerId, j]));
    expect(byId[hot.id]!.opts.priority).toBe(1); // HIGH: 3 users' alerts
    expect(byId[cold.id]!.opts.priority).toBe(10); // LOW: nobody watching
    expect(byId[hot.id]!.id).toBe(`price.${hot.id}.2026-11-16T10-00`);

    // Second guard: even if the claim is lost (e.g. the lease row was reset), the same
    // offer+slot is never enqueued twice, and each prevented duplicate is counted.
    await prisma.productOffer.updateMany({
      where: { id: { in: [hot.id, cold.id] } },
      data: { nextCheckAt: null },
    });
    const again = await scheduleDueOffers(deps);
    expect(again).toMatchObject({ enqueued: 0, duplicatesPrevented: 2 });
    expect(await q.count()).toBe(2);
    await prisma.productOffer.updateMany({
      where: { id: { in: [hot.id, cold.id] } },
      data: { nextCheckAt: new Date(clock.getTime() + 15 * 60_000) },
    });

    // Leased: not due again on the next tick…
    expect((await scheduleDueOffers(deps)).enqueued).toBe(0);
    // …until the lease expires (worker died before processing): due again, new slot.
    clock = new Date(clock.getTime() + 16 * 60_000);
    // (3: the offer that was due in 1 minute is now due too.)
    expect((await scheduleDueOffers(deps)).enqueued).toBe(3);
  });

  it("excludes disabled sources, sources with tracking off and non-lookup connectors, and applies backpressure", async () => {
    const q = queue(`pr-${randomUUID()}`);
    await offer("mock_alpha");
    await offer("mock_beta");
    await prisma.shoppingSource.update({
      where: { slug: "mock_beta" },
      data: { status: "DISABLED" },
    });
    const deps = {
      prisma,
      queue: q,
      redis,
      redisPrefix: prefix,
      metrics,
      capableSlugs: () => ["mock_alpha"],
      now: () => clock,
    };
    expect((await scheduleDueOffers(deps)).enqueued).toBe(1);
    await prisma.productOffer.updateMany({ data: { nextCheckAt: null } });
    await prisma.shoppingSource.update({
      where: { slug: "mock_alpha" },
      data: { trackingEnabled: false },
    });
    expect((await scheduleDueOffers(deps)).enqueued).toBe(0);
    await prisma.shoppingSource.update({
      where: { slug: "mock_alpha" },
      data: { trackingEnabled: true },
    });
    expect((await scheduleDueOffers({ ...deps, capableSlugs: () => [] })).enqueued).toBe(0);
    // Queue full: nothing more is added.
    const full = await scheduleDueOffers({ ...deps, maxQueued: 1 });
    expect(full).toMatchObject({ backpressure: true, enqueued: 0 });
  });
});

describe("4–9. refresh: fetch, validation, snapshots, changes, stock", () => {
  it("spends no request on an offer a search just observed, unless a new alert awaits its first answer", async () => {
    await prisma.shoppingSource.updateMany({ data: { cacheTtlSeconds: 300 } });
    const o = await offer("mock_alpha", { observedAt: new Date(clock.getTime() - 60_000) });
    expect(await refresh(o.id)).toMatchObject({ outcome: "RECENTLY_OBSERVED", checkId: null });
    expect(alpha.total()).toBe(0);
    await alert((await user(1)).id, o.variantId);
    await prisma.productOffer.update({
      where: { id: o.id },
      data: { observedAt: new Date(clock.getTime() - 60_000) },
    });
    expect(await refresh(o.id)).toMatchObject({ action: "done", outcome: "UNCHANGED" });
    expect(alpha.total()).toBe(1);
    expect(enqueuedChecks).toHaveLength(1); // the new alert gets evaluated
  });

  it("fetches once, records a decrease with a new snapshot, never rewriting history", async () => {
    const o = await offer("mock_alpha");
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_950_000 });
    const before = await prisma.priceSnapshot.findMany({ where: { offerId: o.id } });
    const r = await refresh(o.id);
    expect(r).toMatchObject({ action: "done", outcome: "PRICE_DECREASED", changed: true });
    expect(alpha.calls.get(o.externalId)).toBe(1);
    const check = await prisma.priceCheck.findFirstOrThrow({ where: { offerId: o.id } });
    expect(check).toMatchObject({
      changePaise: -150_000n,
      changeBp: -714,
      previousPricePaise: 2_100_000n,
    });
    const after = await prisma.priceSnapshot.findMany({
      where: { offerId: o.id },
      orderBy: { observedAt: "asc" },
    });
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]); // untouched
    expect(after[1]!.sellingPricePaise).toBe(1_950_000n);
    const updated = await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } });
    expect(updated.sellingPricePaise).toBe(1_950_000n);
    expect(updated.nextCheckAt!.getTime()).toBeGreaterThan(clock.getTime());
    expect(enqueuedChecks).toEqual([check.id]);
  });

  it("detects an increase; unchanged checks write no snapshot until the heartbeat", async () => {
    const o = await offer("mock_alpha");
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_250_000 });
    expect(await refresh(o.id)).toMatchObject({ outcome: "PRICE_INCREASED" });
    clock = new Date(clock.getTime() + 3_600_000);
    expect(await refresh(o.id)).toMatchObject({ outcome: "UNCHANGED", changed: false });
    expect(await prisma.priceSnapshot.count({ where: { offerId: o.id } })).toBe(2);
    clock = new Date(clock.getTime() + 13 * 3_600_000);
    await refresh(o.id);
    expect(await prisma.priceSnapshot.count({ where: { offerId: o.id } })).toBe(3);
  });

  it("rejects invalid prices without touching the offer, and holds implausible jumps until confirmed", async () => {
    const o = await offer("mock_alpha");
    alpha.listings.set(o.externalId, { sellingPricePaise: 0 });
    expect(await refresh(o.id)).toMatchObject({ outcome: "INVALID" });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_000_000, priceType: "INDICATIVE" });
    expect(await refresh(o.id)).toMatchObject({ outcome: "INVALID" });
    let cur = await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur.sellingPricePaise).toBe(2_100_000n);
    expect(cur.consecutiveFailures).toBe(2);
    expect(await prisma.priceSnapshot.count({ where: { offerId: o.id } })).toBe(1);

    // A 95% "drop": held once, accepted when the next check confirms it.
    alpha.listings.set(o.externalId, { sellingPricePaise: 105_000 });
    expect(await refresh(o.id)).toMatchObject({ outcome: "INVALID" });
    cur = await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } });
    expect(cur.sellingPricePaise).toBe(2_100_000n);
    expect(await refresh(o.id)).toMatchObject({ outcome: "PRICE_DECREASED" });
  });

  it("tracks stock changes, disappearance (price never zeroed) and reappearance", async () => {
    const o = await offer("mock_alpha");
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_100_000, stockStatus: "OUT_OF_STOCK" });
    expect(await refresh(o.id)).toMatchObject({ outcome: "OTHER_CHANGED", changed: true });
    alpha.listings.set(o.externalId, { gone: true });
    expect(await refresh(o.id)).toMatchObject({ outcome: "MISSING" });
    const missing = await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } });
    expect(missing).toMatchObject({ trackingState: "MISSING", sellingPricePaise: 2_100_000n });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_050_000 });
    expect(await refresh(o.id)).toMatchObject({ outcome: "REAPPEARED" });
    expect(
      (await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } })).trackingState,
    ).toBe("ACTIVE");
    // Missing too long → expired by cleanup (and no longer scheduled).
    alpha.listings.set(o.externalId, { gone: true });
    await refresh(o.id);
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    expect(
      (await runCleanup({ prisma, enqueueDelivery: async () => undefined, now: () => clock }))
        .expiredOffers,
    ).toBe(1);
  });
});

describe("10–13. alert evaluation: many users, no duplicates, cooldown, preferences", () => {
  it("one marketplace request serves every user's alert (no per-user fetches)", async () => {
    const q = queue(`pr-${randomUUID()}`);
    const o = await offer("mock_alpha");
    const users = [];
    for (let i = 0; i < 25; i += 1) users.push(await user(i));
    for (const u of users) await alert(u.id, o.variantId);
    const deps = {
      prisma,
      queue: q,
      redis,
      redisPrefix: prefix,
      metrics,
      capableSlugs: () => lookup.lookupCapableSlugs(),
      now: () => clock,
    };
    expect((await scheduleDueOffers(deps)).enqueued).toBe(1);
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    const job = (await q.getJobs(["prioritized", "waiting"]))[0]!;
    const r = await refresh(priceRefreshJob.parse(job.data).offerId);
    expect(alpha.total()).toBe(1);
    const s = await evaluate((r as { checkId: string }).checkId);
    expect(s).toMatchObject({ evaluated: 25, triggered: 25, notifications: 25 });
    const notes = await prisma.notification.findMany();
    expect(new Set(notes.map((n) => n.userId)).size).toBe(25);
    expect(notes[0]).toMatchObject({ type: "TARGET_PRICE_REACHED" });
    expect(alpha.total()).toBe(1); // still one fetch for 25 users
  });

  it("never notifies twice for the same check (retries and concurrent jobs)", async () => {
    const o = await offer("mock_alpha");
    const u = await user(1);
    await alert(u.id, o.variantId);
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    const { checkId } = (await refresh(o.id)) as { checkId: string };
    const [a, b] = await Promise.all([evaluate(checkId), evaluate(checkId)]);
    const again = await evaluate(checkId);
    expect(a.notifications + b.notifications + again.notifications).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.alertEvaluation.count()).toBe(1);
  });

  it("enforces the cooldown across checks, re-notifies after it on a further drop", async () => {
    const o = await offer("mock_alpha");
    const o2 = await prisma.productOffer.create({
      data: {
        productId: o.productId,
        variantId: o.variantId,
        sourceId: await sourceId("mock_beta"),
        externalId: "beta-1",
        productUrl: "https://example.com/beta-1",
        title: o.title,
        sellingPricePaise: 2_100_000n,
        stockStatus: "IN_STOCK",
      },
    });
    beta.listings.set("beta-1", { sellingPricePaise: 1_980_000 });
    const u = await user(1);
    // A repeating alert keeps watching after a trigger (cooldown applies).
    const a = await alert(u.id, o.variantId, { cooldownMinutes: 60, repeat: true });
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    await evaluate(((await refresh(o.id)) as { checkId: string }).checkId);
    // Another marketplace drops further 5 minutes later: inside the cooldown.
    clock = new Date(clock.getTime() + 5 * 60_000);
    await evaluate(((await refresh(o2.id)) as { checkId: string }).checkId);
    const evals = await prisma.alertEvaluation.findMany({ orderBy: { evaluatedAt: "asc" } });
    expect(evals.map((e) => e.outcome)).toEqual(["TRIGGERED", "COOLDOWN"]);
    expect(await prisma.notification.count()).toBe(1);
    // After the cooldown, a further drop notifies again.
    clock = new Date(clock.getTime() + 61 * 60_000);
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_970_000 });
    await evaluate(((await refresh(o.id)) as { checkId: string }).checkId);
    expect(await prisma.notification.count()).toBe(2);
    expect(
      (await prisma.priceAlert.findUniqueOrThrow({ where: { id: a.id } })).lastTriggeredPricePaise,
    ).toBe(1_970_000n);
  });

  it("respects preferences, pause, ownership and other alert types", async () => {
    const o = await offer("mock_alpha");
    const quiet = await user(1, { notifyEmail: false, notifyInApp: false });
    const inAppOnly = await user(2, { notifyEmail: false });
    const paused = await user(3);
    const stock = await user(4);
    await alert(quiet.id, o.variantId);
    await alert(inAppOnly.id, o.variantId);
    await alert(paused.id, o.variantId, { status: "PAUSED" });
    await alert(stock.id, o.variantId, { type: "BACK_IN_STOCK", targetPricePaise: null });
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    const s = await evaluate(((await refresh(o.id)) as { checkId: string }).checkId);
    expect(s.evaluated).toBe(3); // the paused alert is skipped
    const byUser = Object.fromEntries(
      (await prisma.alertEvaluation.findMany()).map((e) => [e.userId, e.outcome]),
    );
    expect(byUser).toEqual({
      [quiet.id]: "SUPPRESSED",
      [inAppOnly.id]: "TRIGGERED",
      [stock.id]: "NOT_MET",
    });
    const n = await prisma.notification.findFirstOrThrow({ include: { deliveries: true } });
    expect(n.userId).toBe(inAppOnly.id);
    expect(Object.fromEntries(n.deliveries.map((d) => [d.channel, d.status]))).toEqual({
      IN_APP: "SENT",
      EMAIL: "SKIPPED",
      PUSH: "SKIPPED",
    });
    expect(enqueuedDeliveries).toEqual([]);
  });
});

describe("notification delivery through the shared service", () => {
  it("sends once per delivery (idempotency key), skips without a service", async () => {
    const o = await offer("mock_alpha");
    const u = await user(1);
    await alert(u.id, o.variantId);
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    await evaluate(((await refresh(o.id)) as { checkId: string }).checkId);
    expect(enqueuedDeliveries).toHaveLength(1);
    const sent: EmailMessage[] = [];
    const email = {
      name: "test",
      send: async (m: EmailMessage) => (sent.push(m), { messageId: "m-1" }),
    };
    const deps = {
      prisma,
      metrics,
      email,
      push: null,
      tokenSecret: "t".repeat(40),
      appUrl: "http://localhost:3100",
    };
    const id = enqueuedDeliveries[0]!;
    expect(
      await processNotificationDelivery(deps, { deliveryId: id }, { attempt: 1, maxAttempts: 3 }),
    ).toEqual({ action: "done", status: "SENT" });
    expect(
      await processNotificationDelivery(deps, { deliveryId: id }, { attempt: 1, maxAttempts: 3 }),
    ).toEqual({ action: "done", status: "NOT_PENDING" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: u.email, idempotencyKey: id });
    expect(sent[0]!.html).toContain("₹19,900");
    expect(sent[0]!.text).toContain("http://localhost:3100/unsubscribe?token=");
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id } })).providerMessageId,
    ).toBe("m-1");

    // Push was skipped (off by default); forced back to PENDING it is still skipped at send time.
    const d2 = await prisma.notificationDelivery.update({
      where: {
        notificationId_channel: {
          notificationId: (await prisma.notification.findFirstOrThrow()).id,
          channel: "PUSH",
        },
      },
      data: { status: "PENDING" },
    });
    expect(
      await processNotificationDelivery(
        { ...deps, email: null },
        { deliveryId: d2.id },
        { attempt: 1, maxAttempts: 3 },
      ),
    ).toEqual({ action: "done", status: "SKIPPED" });
  });
});

describe("14–18. reliability: rate limits, retries, dead letters, restarts, concurrency", () => {
  it("stays within the source rate limit and delays (not fails) the rest", async () => {
    await prisma.shoppingSource.update({
      where: { slug: "mock_alpha" },
      data: { rateLimitPerMinute: 2 },
    });
    const offers = [
      await offer("mock_alpha"),
      await offer("mock_alpha"),
      await offer("mock_alpha"),
    ];
    const results = [];
    for (const o of offers) results.push(await refresh(o.id));
    expect(results.map((r) => r.action)).toEqual(["done", "done", "delay"]);
    expect(alpha.total()).toBe(2);
  });

  it("retries a transient marketplace failure through BullMQ (jitter backoff) and then succeeds", async () => {
    const name = `pr-${randomUUID()}`;
    const q = queue(name);
    const dlq = queue(`dlq-${randomUUID()}`);
    const o = await offer("mock_alpha");
    alpha.failuresLeft.set(o.externalId, 2);
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    const w = createTrackedWorker({
      queue: name,
      schema: priceRefreshJob,
      connection,
      prefix: bullPrefix,
      concurrency: 1,
      backoff: { baseMs: 20, capMs: 50 },
      deadLetter: dlq,
      metrics,
      log,
      process: (data, ctx) =>
        processPriceRefresh(refreshDeps({ now: () => new Date() }), data, ctx),
    });
    workers.push(w);
    const events = new QueueEvents(name, { connection, prefix: bullPrefix });
    await events.waitUntilReady();
    const job = await q.add(
      QueueName.priceRefresh,
      { offerId: o.id, slot: "s1" },
      { attempts: 4, backoff: { type: "jitter", delay: 20 } },
    );
    await job.waitUntilFinished(events, 15_000);
    await events.close();
    const done = await q.getJob(job.id!);
    expect(done!.attemptsMade).toBe(3);
    expect(alpha.calls.get(o.externalId)).toBe(3);
    expect(
      (await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } })).sellingPricePaise,
    ).toBe(1_990_000n);
    expect(await dlq.count()).toBe(0);
  });

  it("dead-letters a job that exhausts its retries and records the failure", async () => {
    const name = `pr-${randomUUID()}`;
    const q = queue(name);
    const dlq = queue(`dlq-${randomUUID()}`);
    const o = await offer("mock_alpha");
    alpha.failuresLeft.set(o.externalId, 99);
    workers.push(
      createTrackedWorker({
        queue: name,
        schema: priceRefreshJob,
        connection,
        prefix: bullPrefix,
        concurrency: 1,
        backoff: { baseMs: 10, capMs: 20 },
        deadLetter: dlq,
        metrics,
        log,
        process: (data, ctx) =>
          processPriceRefresh(refreshDeps({ now: () => new Date() }), data, ctx),
      }),
    );
    await q.add(
      QueueName.priceRefresh,
      { offerId: o.id, slot: "s1" },
      { attempts: 3, backoff: { type: "jitter", delay: 10 } },
    );
    for (let i = 0; i < 100 && (await dlq.count()) === 0; i += 1)
      await new Promise((r) => setTimeout(r, 100));
    const [dead] = await dlq.getJobs(["waiting", "prioritized", "delayed"]);
    expect(dead!.data).toMatchObject({ queue: name, attemptsMade: 3, data: { offerId: o.id } });
    // The final attempt recorded the failure and backed the offer off.
    const check = await prisma.priceCheck.findFirstOrThrow({ where: { offerId: o.id } });
    expect(check).toMatchObject({ outcome: "FAILED", errorCode: "UPSTREAM", attempt: 3 });
    expect(
      (await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } })).consecutiveFailures,
    ).toBe(1);
  });

  it("recovers a job whose worker died mid-run (stalled job re-queued)", async () => {
    const name = `pr-${randomUUID()}`;
    const q = queue(name);
    const dlq = queue(`dlq-${randomUUID()}`);
    const o = await offer("mock_alpha");
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    let hang = true;
    const make = () =>
      createTrackedWorker({
        queue: name,
        schema: priceRefreshJob,
        connection,
        prefix: bullPrefix,
        concurrency: 1,
        backoff: { baseMs: 10, capMs: 20 },
        deadLetter: dlq,
        metrics,
        log,
        lockDurationMs: 1_000,
        stalledIntervalMs: 500,
        process: async (data, ctx) => {
          if (hang) await new Promise(() => undefined); // simulates a crashed process
          return processPriceRefresh(refreshDeps({ now: () => new Date() }), data, ctx);
        },
      });
    const first = make();
    const job = await q.add(QueueName.priceRefresh, { offerId: o.id, slot: "s1" }, { attempts: 3 });
    for (let i = 0; i < 50 && (await job.getState()) !== "active"; i += 1)
      await new Promise((r) => setTimeout(r, 50));
    await first.close(true); // force: the lock is not released, as if the process died
    hang = false;
    const second = make();
    workers.push(second);
    for (
      let i = 0;
      i < 150 && (await (await q.getJob(job.id!))!.getState()) !== "completed";
      i += 1
    )
      await new Promise((r) => setTimeout(r, 100));
    expect(await (await q.getJob(job.id!))!.getState()).toBe("completed");
    expect(
      (await prisma.productOffer.findUniqueOrThrow({ where: { id: o.id } })).sellingPricePaise,
    ).toBe(1_990_000n);
  }, 30_000);

  it("runs refreshes concurrently; a failing marketplace doesn't stop the others", async () => {
    const name = `pr-${randomUUID()}`;
    const q = queue(name);
    const dlq = queue(`dlq-${randomUUID()}`);
    const good = [];
    for (let i = 0; i < 8; i += 1) good.push(await offer("mock_alpha"));
    const bad = [];
    for (let i = 0; i < 4; i += 1) bad.push(await offer("mock_beta"));
    for (const o of good) alpha.listings.set(o.externalId, { sellingPricePaise: 1_990_000 });
    for (const o of bad) beta.failuresLeft.set(o.externalId, 99);
    workers.push(
      createTrackedWorker({
        queue: name,
        schema: priceRefreshJob,
        connection,
        prefix: bullPrefix,
        concurrency: 6,
        backoff: { baseMs: 5, capMs: 10 },
        deadLetter: dlq,
        metrics,
        log,
        process: (data, ctx) =>
          processPriceRefresh(refreshDeps({ now: () => new Date() }), data, ctx),
      }),
    );
    await q.addBulk(
      [...good, ...bad].map((o) => ({
        name: QueueName.priceRefresh,
        data: { offerId: o.id, slot: "s1" },
        opts: { attempts: 2, backoff: { type: "jitter", delay: 5 } },
      })),
    );
    for (let i = 0; i < 100; i += 1) {
      const c = await q.getJobCounts("completed", "failed");
      if ((c.completed ?? 0) + (c.failed ?? 0) === 12) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const c = await q.getJobCounts("completed", "failed");
    // The failing marketplace's 4 jobs are recorded and dead-lettered; the other 8 complete.
    expect(c).toMatchObject({ completed: 8, failed: 4 });
    for (let i = 0; i < 30 && (await dlq.count()) < 4; i += 1) await sleep(100);
    expect(await dlq.count()).toBe(4);
    const updated = await prisma.productOffer.findMany({
      where: { id: { in: good.map((g) => g.id) } },
    });
    expect(updated.every((u) => u.sellingPricePaise === 1_990_000n)).toBe(true);
    const failed = await prisma.priceCheck.count({ where: { outcome: "FAILED" } });
    expect(failed).toBe(4);
    const summary = await metrics.summary(1);
    expect(summary.counters.price_changes).toBeGreaterThanOrEqual(8);
  }, 30_000);
});

describe("Phase 5.2: independent alerts, conditions, lifecycle and channels", () => {
  const checkOf = async (offerId: string) =>
    ((await refresh(offerId)) as { checkId: string }).checkId;

  it("evaluates each user's target independently (₹30,000 vs ₹28,000 at ₹29,500)", async () => {
    const o = await offer("mock_alpha", {}, 3_100_000);
    const a = await user(1);
    const b = await user(2);
    const alertA = await alert(a.id, o.variantId, { targetPricePaise: 3_000_000n });
    const alertB = await alert(b.id, o.variantId, { targetPricePaise: 2_800_000n });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_950_000 });
    await evaluate(await checkOf(o.id));
    const after = Object.fromEntries(
      (await prisma.priceAlert.findMany()).map((x) => [x.id, x.status]),
    );
    expect(after).toEqual({ [alertA.id]: "TRIGGERED", [alertB.id]: "ACTIVE" });
    const notes = await prisma.notification.findMany();
    expect(notes.map((n) => n.userId)).toEqual([a.id]);
    // B's own evaluation says why, without anything about A.
    const evalB = await prisma.alertEvaluation.findFirstOrThrow({ where: { alertId: alertB.id } });
    expect(evalB).toMatchObject({ outcome: "NOT_MET", userId: b.id });
    expect(evalB.reason).toBe("₹29,500 is above the target of ₹28,000.");
    expect(
      (await prisma.priceAlert.findUniqueOrThrow({ where: { id: alertA.id } })).triggerCount,
    ).toBe(1);
  });

  it("one-shot alerts stop after triggering until re-armed", async () => {
    const o = await offer("mock_alpha", {}, 3_100_000);
    const u = await user(1);
    const a = await alert(u.id, o.variantId, { targetPricePaise: 3_000_000n });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_950_000 });
    await evaluate(await checkOf(o.id));
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_900_000 });
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    const s2 = await evaluate(await checkOf(o.id));
    expect(s2.evaluated).toBe(0); // TRIGGERED alerts aren't evaluated
    // The user re-arms it (API: resume) → it notifies again on the next qualifying check.
    await prisma.priceAlert.update({
      where: { id: a.id },
      data: { status: "ACTIVE", lastTriggeredPricePaise: null, lastEvaluatedAt: null },
    });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_850_000 });
    await evaluate(await checkOf(o.id));
    expect(await prisma.notification.count()).toBe(2);
  });

  it("percentage drop from the start price", async () => {
    const o = await offer("mock_alpha", {}, 2_000_000);
    const u = await user(1);
    await alert(u.id, o.variantId, {
      type: "PERCENT_DROP",
      targetPricePaise: null,
      dropPercentBp: 1000,
      baselinePricePaise: 2_000_000n,
    });
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_850_000 }); // 7.5%
    await evaluate(await checkOf(o.id));
    expect(await prisma.notification.count()).toBe(0);
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_800_000 }); // 10%
    await evaluate(await checkOf(o.id));
    const n = await prisma.notification.findFirstOrThrow();
    expect(n.type).toBe("PRICE_DROP");
    expect(n.body).toContain("down 10% from ₹20,000 when your alert started");
    expect(n.title).toMatch(/dropped 10%$/);
  });

  it("preferred-marketplace drop: only that marketplace counts, and only by the amount set", async () => {
    const o = await offer("mock_alpha", {}, 2_000_000);
    const betaId = await sourceId("mock_beta");
    const ob = await prisma.productOffer.create({
      data: {
        productId: o.productId,
        variantId: o.variantId,
        sourceId: betaId,
        externalId: "beta-pref",
        productUrl: "https://example.com/beta-pref",
        title: o.title,
        sellingPricePaise: 2_000_000n,
        stockStatus: "IN_STOCK",
      },
    });
    const u = await user(1);
    await alert(u.id, o.variantId, {
      type: "PRICE_DROP",
      targetPricePaise: null,
      sourceId: betaId,
      minChangePaise: 50_000n,
    });
    // A drop on another marketplace doesn't concern this alert.
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_500_000 });
    expect((await evaluate(await checkOf(o.id))).evaluated).toBe(0);
    // ₹300 on the preferred marketplace: below the ₹500 asked for.
    beta.listings.set("beta-pref", { sellingPricePaise: 1_970_000 });
    await evaluate(await checkOf(ob.id));
    expect(await prisma.notification.count()).toBe(0);
    beta.listings.set("beta-pref", { sellingPricePaise: 1_900_000 });
    await evaluate(await checkOf(ob.id));
    const n = await prisma.notification.findFirstOrThrow();
    expect(n.title).toContain("price decreased on Mock Store Beta");
  });

  it("price change by an amount, in either direction", async () => {
    const o = await offer("mock_alpha", {}, 2_000_000);
    const u = await user(1);
    await alert(u.id, o.variantId, {
      type: "PRICE_CHANGE",
      targetPricePaise: null,
      minChangePaise: 100_000n,
      repeat: true,
      cooldownMinutes: 0,
    });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_050_000 });
    await evaluate(await checkOf(o.id));
    expect(await prisma.notification.count()).toBe(0);
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_200_000 });
    await evaluate(await checkOf(o.id));
    expect((await prisma.notification.findFirstOrThrow()).type).toBe("PRICE_CHANGED");
  });

  it("uses only channels both the alert and the user allow", async () => {
    const o = await offer("mock_alpha", {}, 3_100_000);
    const u = await user(1);
    await alert(u.id, o.variantId, { targetPricePaise: 3_000_000n, channels: ["EMAIL"] });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_950_000 });
    await evaluate(await checkOf(o.id));
    const n = await prisma.notification.findFirstOrThrow({ include: { deliveries: true } });
    expect(Object.fromEntries(n.deliveries.map((d) => [d.channel, d.status]))).toEqual({
      IN_APP: "SKIPPED",
      EMAIL: "PENDING",
      PUSH: "SKIPPED",
    });
    expect(enqueuedDeliveries).toHaveLength(1);
  });

  it("two concurrent checks can't both trigger a one-shot alert", async () => {
    const o = await offer("mock_alpha", {}, 3_100_000);
    const ob = await prisma.productOffer.create({
      data: {
        productId: o.productId,
        variantId: o.variantId,
        sourceId: await sourceId("mock_beta"),
        externalId: "beta-race",
        productUrl: "https://example.com/beta-race",
        title: o.title,
        sellingPricePaise: 3_100_000n,
        stockStatus: "IN_STOCK",
      },
    });
    const u = await user(1);
    await alert(u.id, o.variantId, { targetPricePaise: 3_000_000n, cooldownMinutes: 0 });
    alpha.listings.set(o.externalId, { sellingPricePaise: 2_950_000 });
    beta.listings.set("beta-race", { sellingPricePaise: 2_940_000 });
    const [c1, c2] = [await checkOf(o.id), await checkOf(ob.id)];
    await Promise.all([evaluate(c1), evaluate(c2)]);
    expect(await prisma.notification.count()).toBe(1);
    const outcomes = (await prisma.alertEvaluation.findMany()).map((e) => e.outcome).sort();
    expect(outcomes.filter((x) => x === "TRIGGERED")).toHaveLength(1);
  });

  it("expires alerts past their end date once, with an in-app notice", async () => {
    const o = await offer("mock_alpha");
    const u = await user(1);
    // Every channel off: nothing to tell this user.
    const quiet = await user(2, { notifyInApp: false, notifyEmail: false });
    const a = await alert(u.id, o.variantId, { expiresAt: new Date(clock.getTime() + 3_600_000) });
    await alert(quiet.id, o.variantId, {
      status: "PAUSED",
      expiresAt: new Date(clock.getTime() + 3_600_000),
    });
    const later = new Date(clock.getTime() + 2 * 3_600_000);
    const r1 = await runCleanup({
      prisma,
      enqueueDelivery: async () => undefined,
      now: () => later,
    });
    const r2 = await runCleanup({
      prisma,
      enqueueDelivery: async () => undefined,
      now: () => later,
    });
    expect([r1.expiredAlerts, r2.expiredAlerts]).toEqual([2, 0]);
    expect((await prisma.priceAlert.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      "EXPIRED",
    );
    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1); // the quiet user turned every channel off
    expect(notes[0]).toMatchObject({
      userId: u.id,
      type: "ALERT_EXPIRED",
      sourceType: "ALERT_EXPIRY",
      dedupeKey: `alert:${a.id}:expired`,
    });
    // An expired alert is never evaluated again.
    alpha.listings.set(o.externalId, { sellingPricePaise: 1_000_000 });
    clock = later;
    expect((await evaluate(await checkOf(o.id))).evaluated).toBe(0);
  });
});
