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
 *    notification on the alert's channels that the user's preferences allow;
 *  - personal-data retention (Phase 7.1, data minimisation): ended sessions
 *    (IP address, user agent) after 30 days; finished notification deliveries
 *    after 90 days; notifications after 365 days; finished searches with their
 *    results, source runs and agent runs after 365 days (configurable).
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
  /** Days a revoked/expired session row (IP, user agent) is kept. */
  sessionRetentionDays?: number;
  /** Days a finished (SENT/FAILED/SKIPPED) delivery record is kept. */
  deliveryRetentionDays?: number;
  notificationRetentionDays?: number;
  /** Days a finished search (and its results/runs) is kept. */
  searchRetentionDays?: number;
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
  /** Personal-data retention (rows deleted). */
  retention: { sessions: number; deliveries: number; notifications: number; searches: number };
}

const DAY = 86_400_000;

/** Fixed retention conditions: `$1` is the cut-off time. Never built from input. */
const RETENTION_RULES = {
  PriceCheck: `"checkedAt" < $1`,
  AlertEvaluation: `"evaluatedAt" < $1`,
  UserSession: `("revokedAt" < $1 OR "expiresAt" < $1)`,
  NotificationDelivery: `"status" IN ('SENT', 'FAILED', 'SKIPPED') AND "createdAt" < $1`,
  Notification: `"createdAt" < $1`,
  Search: `"status" NOT IN ('PENDING', 'RUNNING') AND "createdAt" < $1`,
} as const;

async function deleteInBatches(
  prisma: PrismaClient,
  table: keyof typeof RETENTION_RULES,
  before: Date,
  batch: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    // Table names and conditions are the fixed literals above, never user input.
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE "id" IN (SELECT "id" FROM "${table}" WHERE ${RETENTION_RULES[table]} LIMIT $2)`,
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
    new Date(now.getTime() - (deps.evaluationRetentionDays ?? 90) * DAY),
    batch,
  );
  const deletedChecks = await deleteInBatches(
    deps.prisma,
    "PriceCheck",
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
  const cutoff = (days: number) => new Date(now.getTime() - days * DAY);
  const retention = {
    sessions: await deleteInBatches(
      deps.prisma,
      "UserSession",
      cutoff(deps.sessionRetentionDays ?? 30),
      batch,
    ),
    deliveries: await deleteInBatches(
      deps.prisma,
      "NotificationDelivery",
      cutoff(deps.deliveryRetentionDays ?? 90),
      batch,
    ),
    notifications: await deleteInBatches(
      deps.prisma,
      "Notification",
      cutoff(deps.notificationRetentionDays ?? 365),
      batch,
    ),
    searches: await deleteInBatches(
      deps.prisma,
      "Search",
      cutoff(deps.searchRetentionDays ?? 365),
      batch,
    ),
  };
  return {
    affiliateClicks,
    retention,
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
