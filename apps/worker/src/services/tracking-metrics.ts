/**
 * Tracking counters in Redis, bucketed per hour (kept 8 days) so every worker
 * process contributes and the admin API can read totals (key format shared in
 * @dealmind/queue). Mirrored to OpenTelemetry metrics (no-op unless an SDK is
 * configured).
 */
import {
  type TrackingCounter,
  type TrackingSummary,
  readTrackingSummary,
  trackingMetricsKey,
} from "@dealmind/queue";
import { metrics as otel } from "@opentelemetry/api";
import type { Redis } from "ioredis";

const RETENTION_SECONDS = 8 * 24 * 3600;
const meter = otel.getMeter("dealmind-worker");
const otelCounter = meter.createCounter("dealmind.tracking.events", {
  description: "Price tracking events by kind",
});
const latency = meter.createHistogram("dealmind.tracking.lookup_ms", {
  description: "Marketplace lookup latency",
  unit: "ms",
});

export class TrackingMetrics {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inc(counters: Partial<Record<TrackingCounter, number>>): Promise<void> {
    const entries = Object.entries(counters).filter(([, v]) => v);
    if (!entries.length) return;
    const key = trackingMetricsKey(this.prefix, this.now());
    const multi = this.redis.multi();
    for (const [k, v] of entries) {
      multi.hincrby(key, k, v);
      otelCounter.add(v, { kind: k });
    }
    multi.expire(key, RETENTION_SECONDS);
    await multi.exec();
  }

  async lookup(source: string, ms: number): Promise<void> {
    const key = trackingMetricsKey(this.prefix, this.now());
    latency.record(ms, { source });
    await this.redis
      .multi()
      .hincrby(key, `lookup_ms_sum:${source}`, Math.round(ms))
      .hincrby(key, `lookup_count:${source}`, 1)
      .expire(key, RETENTION_SECONDS)
      .exec();
  }

  summary(hours = 24): Promise<TrackingSummary> {
    return readTrackingSummary(this.redis, this.prefix, hours, this.now());
  }
}
