/**
 * Tracking housekeeping (hourly):
 *  - offers missing longer than the expiry window become EXPIRED (no longer
 *    scheduled; history is kept);
 *  - PriceCheck and AlertEvaluation rows past retention are deleted in
 *    batches. PriceSnapshot history is never deleted or rewritten;
 *  - email deliveries left PENDING (e.g. the enqueue was lost in a crash)
 *    are re-enqueued; their job id is the delivery id, so this is idempotent;
 *  - alerts past their end date become EXPIRED (one conditional UPDATE …
 *    RETURNING, so each is expired and announced once) with an in-app
 *    "alert ended" notification when the alert and the user allow in-app.
 */
import type { PrismaClient } from "@dealmind/db";

export interface CleanupDeps {
  prisma: PrismaClient;
  enqueueDelivery: (deliveryId: string) => Promise<void>;
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
  const expiredAlerts = await expireAlerts(deps.prisma, now);
  const stuck = await deps.prisma.notificationDelivery.findMany({
    where: {
      channel: "EMAIL",
      status: "PENDING",
      createdAt: { lt: new Date(now.getTime() - 10 * 60_000) },
    },
    select: { id: true },
    take: 1_000,
  });
  for (const d of stuck) await deps.enqueueDelivery(d.id);
  return {
    expiredAlerts,
    expiredOffers: expired.count,
    deletedChecks,
    deletedEvaluations,
    requeuedDeliveries: stuck.length,
  };
}

const dateText = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

/**
 * Ends alerts whose end date passed and tells their owners (in-app). One
 * transaction per alert: the conditional status change and its notice commit
 * together, so a crash can neither lose the notice nor send it twice.
 */
async function expireAlerts(prisma: PrismaClient, now: Date): Promise<number> {
  const due = await prisma.priceAlert.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED", "TRIGGERED"] }, expiresAt: { lte: now } },
    select: {
      id: true,
      userId: true,
      variantId: true,
      channels: true,
      expiresAt: true,
      user: { select: { preference: { select: { notifyInApp: true } } } },
      variant: { select: { product: { select: { id: true, name: true } } } },
    },
    take: 1_000,
  });
  let expired = 0;
  for (const a of due) {
    await prisma.$transaction(async (tx) => {
      const res = await tx.priceAlert.updateMany({
        where: {
          id: a.id,
          status: { in: ["ACTIVE", "PAUSED", "TRIGGERED"] },
          expiresAt: { lte: now },
        },
        data: { status: "EXPIRED" },
      });
      if (res.count === 0) return; // changed meanwhile (e.g. cancelled by the user)
      expired += 1;
      if (!a.channels.includes("IN_APP") || a.user.preference?.notifyInApp === false) return;
      const p = a.variant.product;
      const n = await tx.notification.create({
        data: {
          userId: a.userId,
          type: "ALERT_EXPIRED",
          title: `Your price alert for ${p.name} has ended`,
          body: `It reached the end date you set (${dateText.format(a.expiresAt!)}) and is no longer checked. Create a new alert to keep watching.`,
          data: { alertId: a.id, productId: p.id, variantId: a.variantId },
        },
      });
      await tx.notificationDelivery.createMany({
        data: [
          {
            userId: a.userId,
            notificationId: n.id,
            channel: "IN_APP",
            status: "SENT",
            sentAt: now,
          },
          // The shared notification service has no template for this notice.
          {
            userId: a.userId,
            notificationId: n.id,
            channel: "EMAIL",
            status: "SKIPPED",
            lastError: "Expiry notices are in-app only",
          },
        ],
      });
    });
  }
  return expired;
}
