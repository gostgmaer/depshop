/**
 * Price-tracking counters: hourly Redis hashes written by apps/worker and read
 * by the admin API. Shared here so the key format can't drift between them.
 */
export const TRACKING_COUNTERS = [
  "jobs_total",
  "jobs_succeeded",
  "jobs_failed",
  "jobs_dead_lettered",
  "jobs_rate_limited",
  "duplicates_prevented",
  "price_changes",
  "price_decreases",
  "price_increases",
  "stock_changes",
  "snapshots_created",
  "offers_missing",
  "invalid_observations",
  "fresh_skips",
  "alerts_evaluated",
  "alerts_triggered",
  "notifications_created",
  "deliveries_sent",
  "deliveries_failed",
  "scheduler_enqueued",
  "scheduler_backpressure",
  "queue_delay_ms_sum",
  "queue_delay_count",
] as const;
export type TrackingCounter = (typeof TRACKING_COUNTERS)[number];

/** Hash key of one hour's counters (UTC hour). */
export const trackingMetricsKey = (prefix: string, d: Date) =>
  `${prefix}:tracking:metrics:${d.toISOString().slice(0, 13)}`;

export interface TrackingSummary {
  hours: number;
  counters: Record<TrackingCounter, number>;
  averageQueueDelayMs: number | null;
  sources: Record<string, { lookups: number; averageLatencyMs: number | null }>;
}

/** Minimal Redis surface (ioredis-compatible). */
export interface HashReader {
  hgetall(key: string): Promise<Record<string, string>>;
}

export async function readTrackingSummary(
  redis: HashReader,
  prefix: string,
  hours = 24,
  now: Date = new Date(),
): Promise<TrackingSummary> {
  const keys = Array.from({ length: hours }, (_, i) =>
    trackingMetricsKey(prefix, new Date(now.getTime() - i * 3_600_000)),
  );
  const rows = await Promise.all(keys.map((k) => redis.hgetall(k)));
  const counters = Object.fromEntries(TRACKING_COUNTERS.map((c) => [c, 0])) as Record<
    TrackingCounter,
    number
  >;
  const sums: Record<string, { sum: number; count: number }> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const n = Number(v);
      if (k.startsWith("lookup_ms_sum:")) (sums[k.slice(14)] ??= { sum: 0, count: 0 }).sum += n;
      else if (k.startsWith("lookup_count:"))
        (sums[k.slice(13)] ??= { sum: 0, count: 0 }).count += n;
      else if (k in counters) counters[k as TrackingCounter] += n;
    }
  }
  return {
    hours,
    counters,
    averageQueueDelayMs: counters.queue_delay_count
      ? Math.round(counters.queue_delay_ms_sum / counters.queue_delay_count)
      : null,
    sources: Object.fromEntries(
      Object.entries(sums).map(([s, v]) => [
        s,
        { lookups: v.count, averageLatencyMs: v.count ? Math.round(v.sum / v.count) : null },
      ]),
    ),
  };
}
