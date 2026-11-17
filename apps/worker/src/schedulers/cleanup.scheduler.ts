/**
 * Tracking housekeeping (hourly):
 *  - offers missing longer than the expiry window become EXPIRED (no longer
 *    scheduled; history is kept);
 *  - PriceCheck and AlertEvaluation rows past retention are deleted in
 *    batches. PriceSnapshot history is never deleted or rewritten;
 *  - email/push deliveries still PENDING 10 minutes after they were due
 *    (e.g. the enqueue was lost in a crash) are re-enqueued; their job id is
 *    the delivery id, so this is idempotent (outbox recovery);
 *  - alerts past their end date become EXPIRED (a conditional update per
 *    alert, so each is expired and announced once) with an "alert ended"
 *    notification on the alert's channels that the user's preferences allow.
 */
import { applyClickRetention } from "@dealmind/affiliate";
import type { PrismaClient } from "@dealmind/db";
import {
  type PendingDelivery,
  buildNotification,
  publishSignal,
  recordNotification,
} from "@dealmind/notifications";

export interface CleanupDeps {
  prisma: PrismaClient;
  enqueueDelivery: (deliveryId: string, notBefore?: Date) => Promise<void>;
  realtime?: { redis: { publish(c: string, m: string): Promise<unknown> }; prefix: string };
  /** Days an offer may stay MISSING before it expires. */
  expireMissingAfterDays?: number;
  checkRetentionDays?: number;
  evaluationRetentionDays?: number;
  batchSize?: number;
  now?: () => Date;
}

export interface CleanupResult {
  expiredAlerts: number;
  expiredOffers: number;
  deletedChecks: number;
  deletedEvaluations: number;
  requeuedDeliveries: number;
  /** Affiliate clicks whose identifiers were cleared / that were deleted (retention). */
  affiliateClicks: { anonymized: number; deleted: number };
}

const DAY = 86_400_000;

async function deleteInBatches(
  prisma: PrismaClient,
  table: "PriceCheck" | "AlertEvaluation",
  column: "checkedAt" | "evaluatedAt",
  before: Date,
  batch: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    // Identifiers are fixed literals chosen above, never user input.
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE "id" IN (SELECT "id" FROM "${table}" WHERE "${column}" < $1 LIMIT $2)`,
      before,
      batch,
    );
    total += n;
    if (n < batch) return total;
  }
}

export async function runCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  const now = (deps.now ?? (() => new Date()))();
  const batch = deps.batchSize ?? 5_000;
  const expired = await deps.prisma.productOffer.updateMany({
    where: {
      trackingState: "MISSING",
      missingSince: { lt: new Date(now.getTime() - (deps.expireMissingAfterDays ?? 7) * DAY) },
    },
    data: { trackingState: "EXPIRED", nextCheckAt: null },
  });
  // Evaluations reference checks: delete them first.
  const deletedEvaluations = await deleteInBatches(
    deps.prisma,
    "AlertEvaluation",
    "evaluatedAt",
    new Date(now.getTime() - (deps.evaluationRetentionDays ?? 90) * DAY),
    batch,
  );
  const deletedChecks = await deleteInBatches(
    deps.prisma,
    "PriceCheck",
    "checkedAt",
    new Date(now.getTime() - (deps.checkRetentionDays ?? 30) * DAY),
    batch,
  );
  const expiredAlerts = await expireAlerts(deps, now);
  const stuck = await deps.prisma.notificationDelivery.findMany({
    where: {
      channel: { in: ["EMAIL", "PUSH"] },
      status: "PENDING",
      scheduledAt: { lt: new Date(now.getTime() - 10 * 60_000) },
    },
    select: { id: true },
    orderBy: { scheduledAt: "asc" },
    take: 1_000,
  });
  for (const d of stuck) await deps.enqueueDelivery(d.id);
  // Affiliate click privacy: identifiers cleared after 30 days, unconverted clicks deleted after 13 months.
  const affiliateClicks = await applyClickRetention(deps.prisma, now);
  return {
    affiliateClicks,
    expiredAlerts,
    expiredOffers: expired.count,
    deletedChecks,
    deletedEvaluations,
    requeuedDeliveries: stuck.length,
  };
}

/**
 * Ends alerts whose end date passed and tells their owners. One transaction
 * per alert: the conditional status change and its notification (outbox)
 * commit together, so a crash can neither lose the notice nor send it twice.
 */
async function expireAlerts(deps: CleanupDeps, now: Date): Promise<number> {
  const due = await deps.prisma.priceAlert.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED", "TRIGGERED"] }, expiresAt: { lte: now } },
    select: {
      id: true,
      userId: true,
      variantId: true,
      channels: true,
      expiresAt: true,
      variant: { select: { product: { select: { id: true, name: true } } } },
    },
    take: 1_000,
  });
  let expired = 0;
  for (const a of due) {
    const r = await deps.prisma.$transaction(async (tx) => {
      const res = await tx.priceAlert.updateMany({
        where: {
          id: a.id,
          status: { in: ["ACTIVE", "PAUSED", "TRIGGERED"] },
          expiresAt: { lte: now },
        },
        data: { status: "EXPIRED" },
      });
      if (res.count === 0) return null; // changed meanwhile (e.g. cancelled by the user)
      const p = a.variant.product;
      const draft = buildNotification({
        kind: "alert.expired",
        userId: a.userId,
        alertId: a.id,
        product: { id: p.id, name: p.name, variantId: a.variantId },
        expiresAt: a.expiresAt!.toISOString(),
      });
      return recordNotification(tx, draft, { alertChannels: a.channels, now });
    });
    if (!r) continue;
    expired += 1;
    if (r.status !== "created") continue;
    const pending: PendingDelivery[] = r.pending;
    for (const d of pending) await deps.enqueueDelivery(d.id, d.notBefore);
    if (deps.realtime)
      await publishSignal(deps.realtime.redis, deps.realtime.prefix, a.userId, {
        type: "created",
        id: r.notificationId,
      });
  }
  return expired;
}
