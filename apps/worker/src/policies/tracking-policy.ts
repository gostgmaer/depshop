/**
 * Tracking frequency policy. Tracking is global per marketplace offer: the
 * tier comes from how many users care about the offer's variant (active
 * alerts + watchlist entries), never from one user's alert, and the interval
 * comes from the source's own configuration (permitted usage differs per
 * marketplace).
 */
export type DemandTier = "HIGH" | "NORMAL" | "LOW";

export interface SourceIntervals {
  trackingHighMinutes: number;
  trackingNormalMinutes: number;
  trackingLowMinutes: number;
}

export interface TrackingPolicyConfig {
  /** Distinct interested users (alerts + watchlist items) that make a variant high demand. */
  highDemandMin: number;
  /** Upper bound of the failure backoff. */
  maxBackoffMinutes: number;
  /** ± share of the interval added as jitter so offers don't all fall due together. */
  jitterShare: number;
}

export const DEFAULT_POLICY: TrackingPolicyConfig = {
  highDemandMin: 3,
  maxBackoffMinutes: 24 * 60,
  jitterShare: 0.1,
};

export function tierOf(demand: number, cfg: TrackingPolicyConfig = DEFAULT_POLICY): DemandTier {
  if (demand >= cfg.highDemandMin) return "HIGH";
  return demand >= 1 ? "NORMAL" : "LOW";
}

export function intervalMinutes(tier: DemandTier, s: SourceIntervals): number {
  return tier === "HIGH"
    ? s.trackingHighMinutes
    : tier === "NORMAL"
      ? s.trackingNormalMinutes
      : s.trackingLowMinutes;
}

/** BullMQ priority: lower runs first. */
export function priorityOf(tier: DemandTier): number {
  return tier === "HIGH" ? 1 : tier === "NORMAL" ? 5 : 10;
}

/** Next due time after a successful check: the interval ± jitter. */
export function nextCheckAfterSuccess(
  now: Date,
  minutes: number,
  cfg: TrackingPolicyConfig = DEFAULT_POLICY,
  random: () => number = Math.random,
): Date {
  const base = minutes * 60_000;
  const jitter = Math.round((random() * 2 - 1) * cfg.jitterShare * base);
  return new Date(now.getTime() + base + jitter);
}

/** Next due time after a failure: interval × 2^failures, capped. */
export function nextCheckAfterFailure(
  now: Date,
  minutes: number,
  consecutiveFailures: number,
  cfg: TrackingPolicyConfig = DEFAULT_POLICY,
): Date {
  const factor = 2 ** Math.min(10, Math.max(0, consecutiveFailures - 1));
  const capped = Math.min(cfg.maxBackoffMinutes, minutes * factor);
  return new Date(now.getTime() + capped * 60_000);
}

/** Scheduling slot for the stable job id: the minute the offer fell due. */
export function slotOf(due: Date): string {
  return due.toISOString().slice(0, 16);
}
