/**
 * Global tracking scheduler (one tick per minute, BullMQ job scheduler).
 *
 * Selects due marketplace offers — never alerts: a thousand users watching an
 * offer still produce one job for it — from ACTIVE, tracking-enabled sources
 * whose connector can look up single listings, then:
 *  - claims them atomically (UPDATE … RETURNING with a lease), so concurrent
 *    schedulers or restarts can't enqueue the same offer twice; a lease that
 *    expires (worker died) makes the offer due again;
 *  - enqueues one job per offer with a stable id (offer + due slot) and a
 *    Redis NX marker, counting every duplicate that was prevented;
 *  - applies backpressure: never more queued refreshes than the cap;
 *  - prioritizes by demand tier (high-demand offers first).
 */
import type { PrismaClient } from "@dealmind/db";
import { JOBS, QueueName } from "@dealmind/queue";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  DEFAULT_POLICY,
  type TrackingPolicyConfig,
  priorityOf,
  slotOf,
  tierOf,
} from "../policies/tracking-policy.js";
import { PRICE_REFRESH_JOB_OPTIONS } from "../queues/price-tracking.queue.js";
import type { TrackingMetrics } from "../services/tracking-metrics.js";

export interface SchedulerDeps {
  prisma: PrismaClient;
  queue: Pick<Queue, "addBulk" | "getJobCounts">;
  redis: Redis;
  redisPrefix: string;
  metrics: TrackingMetrics;
  /** Slugs whose connector can look up a single listing. */
  capableSlugs: () => string[];
  policy?: TrackingPolicyConfig;
  /** Offers considered per tick. */
  batchSize?: number;
  /** Maximum refresh jobs waiting in the queue (backpressure). */
  maxQueued?: number;
  /** How long a claimed offer stays reserved for its job. */
  leaseMinutes?: number;
  now?: () => Date;
}

export interface ScheduleResult {
  due: number;
  claimed: number;
  enqueued: number;
  duplicatesPrevented: number;
  backpressure: boolean;
  queued: number;
}

export async function scheduleDueOffers(deps: SchedulerDeps): Promise<ScheduleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const policy = deps.policy ?? DEFAULT_POLICY;
  const maxQueued = deps.maxQueued ?? 2_000;
  const counts = await deps.queue.getJobCounts("waiting", "delayed", "prioritized", "active");
  const queued = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
  const room = Math.min(deps.batchSize ?? 500, maxQueued - queued);
  const result: ScheduleResult = {
    due: 0,
    claimed: 0,
    enqueued: 0,
    duplicatesPrevented: 0,
    backpressure: room <= 0,
    queued,
  };
  const slugs = deps.capableSlugs();
  if (room <= 0 || !slugs.length) {
    if (room <= 0) await deps.metrics.inc({ scheduler_backpressure: 1 });
    return result;
  }

  // Due offers, most overdue first (never-checked first).
  const due = await deps.prisma.productOffer.findMany({
    where: {
      trackingState: { in: ["ACTIVE", "MISSING"] },
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
      AND: [{ OR: [{ trackedUntil: null }, { trackedUntil: { gt: now } }] }],
      source: { status: "ACTIVE", trackingEnabled: true, slug: { in: slugs } },
    },
    orderBy: [{ nextCheckAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: room,
    select: { id: true, variantId: true, nextCheckAt: true },
  });
  result.due = due.length;
  if (!due.length) return result;

  // Atomic claim: only offers still due are returned, so a concurrent tick gets none of them.
  const lease = new Date(now.getTime() + (deps.leaseMinutes ?? 15) * 60_000);
  const claimed = await deps.prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ProductOffer" SET "nextCheckAt" = ${lease}
    WHERE "id" = ANY(${due.map((d) => d.id)}::uuid[])
      AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${now})
    RETURNING "id"`;
  const claimedIds = new Set(claimed.map((c) => c.id));
  result.claimed = claimedIds.size;
  result.duplicatesPrevented += due.length - claimedIds.size;

  // Demand per variant in two grouped queries (not one per offer).
  const variantIds = [...new Set(due.map((d) => d.variantId))];
  const [alerts, watches] = await Promise.all([
    deps.prisma.priceAlert.groupBy({
      by: ["variantId"],
      where: { variantId: { in: variantIds }, status: "ACTIVE" },
      _count: { _all: true },
    }),
    deps.prisma.watchlistItem.groupBy({
      by: ["variantId"],
      where: { variantId: { in: variantIds } },
      _count: { _all: true },
    }),
  ]);
  const demand = new Map<string, number>();
  for (const r of [...alerts, ...watches])
    demand.set(r.variantId, (demand.get(r.variantId) ?? 0) + r._count._all);

  const jobs: Parameters<SchedulerDeps["queue"]["addBulk"]>[0] = [];
  for (const offer of due) {
    if (!claimedIds.has(offer.id)) continue;
    const payload = { offerId: offer.id, slot: slotOf(offer.nextCheckAt ?? now) };
    const jobId = JOBS[QueueName.priceRefresh].jobId(payload);
    // Second guard (cheap, cross-process): the same offer+slot is enqueued at most once.
    const fresh = await deps.redis.set(
      `${deps.redisPrefix}:tracking:enqueued:${jobId}`,
      "1",
      "EX",
      6 * 3600,
      "NX",
    );
    if (fresh !== "OK") {
      result.duplicatesPrevented += 1;
      continue;
    }
    const tier = tierOf(demand.get(offer.variantId) ?? 0, policy);
    jobs.push({
      name: QueueName.priceRefresh,
      data: payload,
      opts: { ...PRICE_REFRESH_JOB_OPTIONS, jobId, priority: priorityOf(tier) },
    });
  }
  if (jobs.length) await deps.queue.addBulk(jobs);
  result.enqueued = jobs.length;
  await deps.metrics.inc({
    scheduler_enqueued: result.enqueued,
    duplicates_prevented: result.duplicatesPrevented,
  });
  return result;
}
