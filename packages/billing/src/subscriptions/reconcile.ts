/**
 * Periodic payment-status synchronization (worker, hourly). Re-reads from the
 * provider every paid subscription that is live and either past its period
 * end or not synced recently, so a lost webhook can't leave a user on the
 * wrong plan. Also expires abandoned checkouts.
 */
import type { PrismaClient } from "@dealmind/db";
import type { SubscriptionSync } from "./sync.js";

export interface ReconcileResult {
  checked: number;
  changed: number;
  failed: number;
  expiredCheckouts: number;
}

export async function reconcileSubscriptions(
  prisma: PrismaClient,
  sync: SubscriptionSync,
  opts: { now?: Date; staleAfterMs?: number; batch?: number } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const stale = new Date(now.getTime() - (opts.staleAfterMs ?? 6 * 3_600_000));
  const due = await prisma.subscription.findMany({
    where: {
      planCode: { not: "FREE" },
      status: { in: ["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"] },
      OR: [{ currentPeriodEnd: { lte: now } }, { lastSyncedAt: null }, { lastSyncedAt: { lt: stale } }],
    },
    select: { userId: true },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: opts.batch ?? 500,
  });
  let changed = 0;
  let failed = 0;
  for (const { userId } of due) {
    try {
      const r = await sync.syncUser(userId, { kind: "reconcile" });
      if (r.status === "synced" && r.changes.length) changed += 1;
    } catch {
      failed += 1; // provider outage: retried next run
    }
  }
  const expired = await prisma.checkoutSession.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED", failureReason: "The checkout expired before payment" },
  });
  return { checked: due.length, changed, failed, expiredCheckouts: expired.count };
}
