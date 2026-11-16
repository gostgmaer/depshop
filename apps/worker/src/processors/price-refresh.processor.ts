/**
 * One global price refresh of one marketplace offer (shared by every user).
 *
 *  1. load the offer and its source; skip if it is no longer trackable;
 *  2. skip the fetch when a search observed it moments ago (cost saving);
 *  3. look the listing up through the connector (rate limit, circuit
 *     breaker, timeout, retries, validation: ProductLookupExecutor);
 *  4. validate the observation, detect the change against the stored offer;
 *  5. in one transaction: append a PriceSnapshot when something changed (or
 *     as a periodic heartbeat), update the offer, record a PriceCheck;
 *  6. invalidate catalog caches and enqueue alert evaluation for the check.
 *
 * Snapshots are append-only; a missing or invalid observation never changes
 * a price, and an implausible jump must be observed twice before it counts.
 */
import { invalidateProductCaches } from "@dealmind/catalog";
import {
  type LookupResult,
  type ProductLookupExecutor,
  toOfferConditions,
} from "@dealmind/connectors";
import type { Prisma, PrismaClient } from "@dealmind/db";
import { trace } from "@opentelemetry/api";
import type { Redis } from "ioredis";
import {
  DEFAULT_POLICY,
  type TrackingPolicyConfig,
  intervalMinutes,
  nextCheckAfterFailure,
  nextCheckAfterSuccess,
  tierOf,
} from "../policies/tracking-policy.js";
import { detectChange, isImplausible, validateObservation } from "../services/price-change.js";
import type { TrackingMetrics } from "../services/tracking-metrics.js";

export interface PriceRefreshDeps {
  prisma: PrismaClient;
  lookup: Pick<ProductLookupExecutor, "lookup">;
  metrics: TrackingMetrics;
  /** Enqueues alert evaluation for a check (idempotent per check). */
  enqueueAlertEvaluation: (checkId: string) => Promise<void>;
  redis?: Redis;
  redisPrefix?: string;
  policy?: TrackingPolicyConfig;
  /** Write a heartbeat snapshot when the last one is older than this, even without a change. */
  snapshotHeartbeatHours?: number;
  now?: () => Date;
  random?: () => number;
  /** Per-lookup hard timeout (the job must never hang). */
  lookupTimeoutMs?: number;
}

export type RefreshResult =
  | { action: "done"; outcome: string; checkId: string | null; changed: boolean }
  | { action: "delay"; ms: number; reason: string }
  | { action: "retry"; reason: string };

const SUCCESS_STOCK = new Set(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"]);
const tracer = trace.getTracer("dealmind-worker");

export async function processPriceRefresh(
  deps: PriceRefreshDeps,
  job: { offerId: string },
  ctx: { attempt: number; maxAttempts: number },
): Promise<RefreshResult> {
  return tracer.startActiveSpan("tracking.refresh", async (span) => {
    try {
      const r = await refresh(deps, job, ctx);
      span.setAttribute("dealmind.tracking.action", r.action);
      if (r.action === "done") span.setAttribute("dealmind.tracking.outcome", r.outcome);
      return r;
    } finally {
      span.end();
    }
  });
}

async function refresh(
  deps: PriceRefreshDeps,
  job: { offerId: string },
  ctx: { attempt: number; maxAttempts: number },
): Promise<RefreshResult> {
  const { prisma, metrics } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const policy = deps.policy ?? DEFAULT_POLICY;
  const offer = await prisma.productOffer.findUnique({
    where: { id: job.offerId },
    include: { source: true },
  });
  if (!offer) return { action: "done", outcome: "GONE", checkId: null, changed: false };
  await metrics.inc({ jobs_total: 1 });

  const demand = await demandOf(prisma, offer.variantId);
  const minutes = intervalMinutes(tierOf(demand, policy), offer.source);
  const record = (data: Omit<Prisma.PriceCheckUncheckedCreateInput, "offerId" | "sourceId">) =>
    prisma.priceCheck.create({
      data: { offerId: offer.id, sourceId: offer.sourceId, attempt: ctx.attempt, ...data },
    });

  // No longer trackable: leave the offer as it is and stop scheduling it soon.
  if (
    offer.source.status !== "ACTIVE" ||
    !offer.source.trackingEnabled ||
    offer.trackingState === "EXPIRED" ||
    (offer.trackedUntil && offer.trackedUntil <= now)
  ) {
    await prisma.productOffer.update({
      where: { id: offer.id },
      data: {
        lastCheckedAt: now,
        nextCheckAt: new Date(now.getTime() + offer.source.trackingLowMinutes * 60_000),
      },
    });
    const c = await record({ outcome: "SKIPPED", errorCode: "NOT_TRACKABLE" });
    return { action: "done", outcome: "SKIPPED", checkId: c.id, changed: false };
  }

  // A search observed this listing moments ago: that observation is current, so no
  // request is spent — unless a new alert is waiting for its first answer.
  const ttlMs = offer.source.cacheTtlSeconds * 1000;
  if (
    ttlMs > 0 &&
    offer.trackingState === "ACTIVE" &&
    now.getTime() - offer.observedAt.getTime() < ttlMs &&
    !(await hasUnevaluatedAlerts(prisma, offer.variantId, offer.sourceId))
  ) {
    await prisma.productOffer.update({
      where: { id: offer.id },
      data: {
        lastCheckedAt: now,
        nextCheckAt: nextCheckAfterSuccess(now, minutes, policy, deps.random),
      },
    });
    await metrics.inc({ fresh_skips: 1, jobs_succeeded: 1 });
    return { action: "done", outcome: "RECENTLY_OBSERVED", checkId: null, changed: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.lookupTimeoutMs ?? 60_000);
  let r: LookupResult;
  try {
    r = await deps.lookup.lookup(offer.source.slug, offer.externalId, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (r.status !== "SKIPPED" && r.status !== "RATE_LIMITED" && !r.deduplicated)
    await metrics.lookup(offer.source.slug, r.durationMs);

  const failure = async (outcome: "FAILED" | "INVALID", code?: string, message?: string) => {
    const failures = offer.consecutiveFailures + 1;
    await prisma.productOffer.update({
      where: { id: offer.id },
      data: {
        lastCheckedAt: now,
        consecutiveFailures: failures,
        nextCheckAt: nextCheckAfterFailure(now, minutes, failures, policy),
      },
    });
    const c = await record({
      outcome,
      previousPricePaise: offer.sellingPricePaise,
      previousStock: offer.stockStatus,
      durationMs: r.durationMs,
      ...(code ? { errorCode: code } : {}),
      ...(message ? { errorMessage: message.slice(0, 500) } : {}),
    });
    return c;
  };

  switch (r.status) {
    case "RATE_LIMITED":
      // DealMind's own budget: wait for the window, don't count it as an attempt.
      await metrics.inc({ jobs_rate_limited: 1 });
      return { action: "delay", ms: r.retryAfterMs ?? 1_000, reason: "rate limited" };
    case "SKIPPED": {
      await prisma.productOffer.update({
        where: { id: offer.id },
        data: {
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + offer.source.trackingLowMinutes * 60_000),
        },
      });
      const c = await record({
        outcome: "SKIPPED",
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
      });
      await metrics.inc({ jobs_succeeded: 1 });
      return { action: "done", outcome: "SKIPPED", checkId: c.id, changed: false };
    }
    case "FAILED": {
      if (r.retryable && ctx.attempt < ctx.maxAttempts)
        return { action: "retry", reason: `${r.errorCode ?? "FAILED"}: ${r.errorMessage ?? ""}` };
      const c = await failure("FAILED", r.errorCode, r.errorMessage);
      await metrics.inc({ jobs_failed: 1 });
      // Recorded and backed off. A retryable failure that exhausted its attempts also
      // fails the job, so it reaches the dead-letter queue.
      if (r.retryable)
        return {
          action: "retry",
          reason: `${r.errorCode ?? "FAILED"} after ${ctx.attempt} attempts`,
        };
      return { action: "done", outcome: "FAILED", checkId: c.id, changed: false };
    }
    case "INVALID": {
      const c = await failure("INVALID", r.errorCode, r.errorMessage);
      await metrics.inc({ invalid_observations: 1, jobs_succeeded: 1 });
      return { action: "done", outcome: "INVALID", checkId: c.id, changed: false };
    }
    case "NOT_FOUND": {
      const wasMissing = offer.trackingState === "MISSING";
      await prisma.productOffer.update({
        where: { id: offer.id },
        data: {
          trackingState: "MISSING",
          missingSince: offer.missingSince ?? now,
          lastCheckedAt: now,
          consecutiveFailures: 0,
          nextCheckAt: nextCheckAfterSuccess(
            now,
            offer.source.trackingNormalMinutes,
            policy,
            deps.random,
          ),
        },
      });
      const c = await record({
        outcome: "MISSING",
        previousPricePaise: offer.sellingPricePaise,
        previousStock: offer.stockStatus,
        durationMs: r.durationMs,
      });
      await metrics.inc({ jobs_succeeded: 1, ...(wasMissing ? {} : { offers_missing: 1 }) });
      return { action: "done", outcome: "MISSING", checkId: c.id, changed: !wasMissing };
    }
  }

  // FOUND
  const item = r.item!;
  const problem = validateObservation(item);
  if (problem) {
    const c = await failure("INVALID", problem.code, problem.message);
    await metrics.inc({ invalid_observations: 1, jobs_succeeded: 1 });
    return { action: "done", outcome: "INVALID", checkId: c.id, changed: false };
  }
  const prev = {
    sellingPricePaise: Number(offer.sellingPricePaise),
    mrpPaise: offer.mrpPaise === null ? null : Number(offer.mrpPaise),
    shippingPaise: offer.shippingPaise === null ? null : Number(offer.shippingPaise),
    stockStatus: offer.stockStatus,
  };
  const next = {
    sellingPricePaise: item.sellingPricePaise,
    mrpPaise: item.mrpPaise ?? null,
    shippingPaise: item.shippingPaise ?? null,
    stockStatus: SUCCESS_STOCK.has(item.stockStatus) ? item.stockStatus : "UNKNOWN",
  } as const;
  const change = detectChange(prev, next);

  // An implausible jump (e.g. a 90% "drop" from a parsing glitch upstream) is
  // held until the next check sees the same price.
  if (isImplausible(change)) {
    const last = await prisma.priceCheck.findFirst({
      where: { offerId: offer.id },
      orderBy: { checkedAt: "desc" },
      select: { outcome: true, errorCode: true, newPricePaise: true },
    });
    const confirmed =
      last?.outcome === "INVALID" &&
      last.errorCode === "IMPLAUSIBLE_CHANGE" &&
      last.newPricePaise === BigInt(next.sellingPricePaise);
    if (!confirmed) {
      await prisma.productOffer.update({
        where: { id: offer.id },
        // Re-check soon to confirm or discard.
        data: {
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + Math.min(minutes, 30) * 60_000),
        },
      });
      const c = await record({
        outcome: "INVALID",
        previousPricePaise: offer.sellingPricePaise,
        newPricePaise: BigInt(next.sellingPricePaise),
        previousStock: offer.stockStatus,
        newStock: next.stockStatus,
        errorCode: "IMPLAUSIBLE_CHANGE",
        errorMessage: `Change of ${change.changeBp} bp held until confirmed by the next observation`,
        durationMs: r.durationMs,
      });
      await metrics.inc({ invalid_observations: 1, jobs_succeeded: 1 });
      return { action: "done", outcome: "INVALID", checkId: c.id, changed: false };
    }
  }

  const reappeared = offer.trackingState === "MISSING";
  const outcome = reappeared ? "REAPPEARED" : change.kind;
  const lastSnapshot = await prisma.priceSnapshot.findFirst({
    where: { offerId: offer.id },
    orderBy: { observedAt: "desc" },
    select: { observedAt: true },
  });
  const heartbeatMs = (deps.snapshotHeartbeatHours ?? 12) * 3_600_000;
  const writeSnapshot =
    outcome !== "UNCHANGED" ||
    !lastSnapshot ||
    now.getTime() - lastSnapshot.observedAt.getTime() >= heartbeatMs;

  const check = await prisma.$transaction(async (tx) => {
    const snapshot = writeSnapshot
      ? await tx.priceSnapshot.create({
          data: {
            offerId: offer.id,
            sellingPricePaise: BigInt(next.sellingPricePaise),
            mrpPaise: next.mrpPaise === null ? null : BigInt(next.mrpPaise),
            shippingPaise: next.shippingPaise === null ? null : BigInt(next.shippingPaise),
            stockStatus: next.stockStatus,
            observedAt: now,
          },
        })
      : null;
    await tx.productOffer.update({
      where: { id: offer.id },
      data: {
        sellingPricePaise: BigInt(next.sellingPricePaise),
        mrpPaise: next.mrpPaise === null ? null : BigInt(next.mrpPaise),
        shippingPaise: next.shippingPaise === null ? null : BigInt(next.shippingPaise),
        stockStatus: next.stockStatus,
        ...(item.sellerName ? { sellerName: item.sellerName } : {}),
        offerConditions: toOfferConditions(item) as unknown as Prisma.InputJsonValue,
        ...(item.sourceUpdatedAt ? { sourceUpdatedAt: item.sourceUpdatedAt } : {}),
        observedAt: now,
        trackingState: "ACTIVE",
        missingSince: null,
        consecutiveFailures: 0,
        lastCheckedAt: now,
        nextCheckAt: nextCheckAfterSuccess(now, minutes, policy, deps.random),
      },
    });
    return tx.priceCheck.create({
      data: {
        offerId: offer.id,
        sourceId: offer.sourceId,
        outcome,
        previousPricePaise: offer.sellingPricePaise,
        newPricePaise: BigInt(next.sellingPricePaise),
        changePaise: BigInt(change.changePaise),
        changeBp: change.changeBp,
        previousStock: offer.stockStatus,
        newStock: next.stockStatus,
        snapshotId: snapshot?.id ?? null,
        attempt: ctx.attempt,
        durationMs: r.durationMs,
      },
    });
  });

  const changed = outcome !== "UNCHANGED";
  await metrics.inc({
    jobs_succeeded: 1,
    ...(writeSnapshot ? { snapshots_created: 1 } : {}),
    ...(change.priceChanged ? { price_changes: 1 } : {}),
    ...(change.kind === "PRICE_DECREASED" ? { price_decreases: 1 } : {}),
    ...(change.kind === "PRICE_INCREASED" ? { price_increases: 1 } : {}),
    ...(change.stockChanged ? { stock_changes: 1 } : {}),
  });
  if (changed && deps.redis && deps.redisPrefix)
    await invalidateProductCaches(deps.redis, deps.redisPrefix, [offer.productId]);
  // Alerts react to changes; a new alert is also checked once on an unchanged price.
  if (changed || (await hasUnevaluatedAlerts(prisma, offer.variantId, offer.sourceId)))
    await deps.enqueueAlertEvaluation(check.id);
  return { action: "done", outcome, checkId: check.id, changed };
}

/** Distinct interest in a variant: active alerts + watchlist entries (any users). */
export async function demandOf(prisma: PrismaClient, variantId: string): Promise<number> {
  const [alerts, watches] = await Promise.all([
    prisma.priceAlert.count({ where: { variantId, status: "ACTIVE" } }),
    prisma.watchlistItem.count({ where: { variantId } }),
  ]);
  return alerts + watches;
}

async function hasUnevaluatedAlerts(prisma: PrismaClient, variantId: string, sourceId: string) {
  return (
    (await prisma.priceAlert.count({
      where: {
        variantId,
        status: "ACTIVE",
        lastEvaluatedAt: null,
        OR: [{ sourceId: null }, { sourceId }],
      },
    })) > 0
  );
}
