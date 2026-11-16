/**
 * Tracking housekeeping (hourly):
 *  - offers missing longer than the expiry window become EXPIRED (no longer
 *    scheduled; history is kept);
 *  - PriceCheck and AlertEvaluation rows past retention are deleted in
 *    batches. PriceSnapshot history is never deleted or rewritten;
 *  - email deliveries left PENDING (e.g. the enqueue was lost in a crash)
 *    are re-enqueued; their job id is the delivery id, so this is idempotent.
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
    expiredOffers: expired.count,
    deletedChecks,
    deletedEvaluations,
    requeuedDeliveries: stuck.length,
  };
}
