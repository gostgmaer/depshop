/**
 * Which plan's limits apply right now (pure). Paid access requires a
 * subscription in good standing; a failed renewal keeps paid access for a
 * grace period while the payment service retries, then falls back to FREE.
 * A subscription whose period ended without a sync (missed events) also
 * falls back after the grace period, so a lost webhook never grants paid
 * access indefinitely.
 */
import type { PlanCode, SubscriptionStatusValue } from "@dealmind/shared";

export const DEFAULT_GRACE_DAYS = 3;
const DAY = 86_400_000;

export interface SubscriptionState {
  planCode: PlanCode;
  status: SubscriptionStatusValue;
  currentPeriodEnd: Date | null;
  pastDueSince: Date | null;
}

export interface Effective {
  plan: PlanCode;
  /** PAST_DUE (or an unsynced lapse): when paid access ends. */
  graceUntil: Date | null;
  reason: string;
}

export function effectivePlan(
  sub: SubscriptionState | null,
  now: Date,
  graceDays = DEFAULT_GRACE_DAYS,
): Effective {
  if (!sub || sub.planCode === "FREE") return { plan: "FREE", graceUntil: null, reason: "free" };
  const grace = graceDays * DAY;
  const periodEnd = sub.currentPeriodEnd?.getTime() ?? null;
  switch (sub.status) {
    case "ACTIVE":
    case "TRIALING": {
      if (periodEnd !== null && now.getTime() > periodEnd + grace)
        return { plan: "FREE", graceUntil: null, reason: "period ended without renewal" };
      return {
        plan: sub.planCode,
        graceUntil:
          periodEnd !== null && now.getTime() > periodEnd ? new Date(periodEnd + grace) : null,
        reason: sub.status.toLowerCase(),
      };
    }
    case "PAST_DUE": {
      const from = sub.pastDueSince?.getTime() ?? periodEnd ?? now.getTime();
      const until = from + grace;
      return now.getTime() < until
        ? { plan: sub.planCode, graceUntil: new Date(until), reason: "past due (grace period)" }
        : { plan: "FREE", graceUntil: null, reason: "past due, grace period over" };
    }
    default:
      return { plan: "FREE", graceUntil: null, reason: sub.status.toLowerCase() };
  }
}
