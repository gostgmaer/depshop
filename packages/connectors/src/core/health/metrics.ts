/**
 * Connector metrics: request/success/failure/timeout/rate-limit counts,
 * latency, result counts, error categories and last success/failure.
 *
 * Two sinks: OpenTelemetry instruments (no-op unless an OTel SDK is
 * installed by the host process) and a queryable store (Redis hashes shared by
 * all processes, or memory in tests) that the API reads for /sources.
 */
import { metrics as otel } from "@opentelemetry/api";
import type { Redis } from "ioredis";
import type { ErrorCategory } from "../types/errors.js";

export interface ExecutionSample {
  sourceId: string;
  outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "SKIPPED";
  durationMs: number;
  resultCount: number;
  cached: boolean;
  errorCategory?: ErrorCategory;
  rateLimited?: boolean;
  at: Date;
}

export interface SourceMetrics {
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  rateLimitEvents: number;
  cacheHits: number;
  results: number;
  latencyMsTotal: number;
  averageLatencyMs: number | null;
  errorsByCategory: Record<string, number>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCategory: string | null;
}

export interface MetricsStore {
  record(sample: ExecutionSample): Promise<void>;
  read(sourceId: string): Promise<SourceMetrics>;
}

const meter = otel.getMeter("@dealmind/connectors");
const otelRequests = meter.createCounter("dealmind.connector.requests", {
  description: "Connector executions",
});
const otelErrors = meter.createCounter("dealmind.connector.errors", {
  description: "Failed connector executions",
});
const otelLatency = meter.createHistogram("dealmind.connector.duration", { unit: "ms" });
const otelResults = meter.createCounter("dealmind.connector.results", {
  description: "Items returned",
});

export function recordOtel(sample: ExecutionSample): void {
  const attrs = {
    "dealmind.source": sample.sourceId,
    "dealmind.outcome": sample.outcome,
    cached: sample.cached,
  };
  otelRequests.add(1, attrs);
  otelLatency.record(sample.durationMs, attrs);
  otelResults.add(sample.resultCount, attrs);
  if (sample.errorCategory) otelErrors.add(1, { ...attrs, "error.type": sample.errorCategory });
}

function toMetrics(h: Record<string, string>): SourceMetrics {
  const n = (k: string) => Number(h[k] ?? 0);
  const errorsByCategory: Record<string, number> = {};
  for (const [k, v] of Object.entries(h))
    if (k.startsWith("error:")) errorsByCategory[k.slice(6)] = Number(v);
  const timed = n("timedRequests");
  return {
    requests: n("requests"),
    successes: n("successes"),
    failures: n("failures"),
    timeouts: n("timeouts"),
    rateLimitEvents: n("rateLimitEvents"),
    cacheHits: n("cacheHits"),
    results: n("results"),
    latencyMsTotal: n("latencyMsTotal"),
    averageLatencyMs: timed ? Math.round(n("latencyMsTotal") / timed) : null,
    errorsByCategory,
    lastSuccessAt: h.lastSuccessAt ?? null,
    lastFailureAt: h.lastFailureAt ?? null,
    lastErrorCategory: h.lastErrorCategory ?? null,
  };
}

function increments(s: ExecutionSample): Record<string, number> {
  const inc: Record<string, number> = { requests: 1, results: s.resultCount };
  if (s.cached) inc.cacheHits = 1;
  else if (s.outcome !== "SKIPPED") {
    inc.timedRequests = 1;
    inc.latencyMsTotal = s.durationMs;
  }
  if (s.outcome === "SUCCEEDED") inc.successes = 1;
  if (s.outcome === "FAILED" || s.outcome === "TIMED_OUT") inc.failures = 1;
  if (s.outcome === "TIMED_OUT") inc.timeouts = 1;
  if (s.rateLimited) inc.rateLimitEvents = 1;
  if (s.errorCategory) inc[`error:${s.errorCategory}`] = 1;
  return inc;
}

export class MemoryMetricsStore implements MetricsStore {
  private readonly data = new Map<string, Record<string, string>>();

  async record(s: ExecutionSample): Promise<void> {
    recordOtel(s);
    const h = this.data.get(s.sourceId) ?? {};
    for (const [k, v] of Object.entries(increments(s))) h[k] = String(Number(h[k] ?? 0) + v);
    if (s.outcome === "SUCCEEDED") h.lastSuccessAt = s.at.toISOString();
    if (s.errorCategory) {
      h.lastFailureAt = s.at.toISOString();
      h.lastErrorCategory = s.errorCategory;
    }
    this.data.set(s.sourceId, h);
  }

  async read(sourceId: string): Promise<SourceMetrics> {
    return toMetrics(this.data.get(sourceId) ?? {});
  }
}

export class RedisMetricsStore implements MetricsStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  key(sourceId: string): string {
    return `${this.prefix}:connectors:metrics:${sourceId}`;
  }

  async record(s: ExecutionSample): Promise<void> {
    recordOtel(s);
    try {
      const m = this.redis.multi();
      for (const [k, v] of Object.entries(increments(s)))
        if (v) m.hincrby(this.key(s.sourceId), k, v);
      if (s.outcome === "SUCCEEDED")
        m.hset(this.key(s.sourceId), "lastSuccessAt", s.at.toISOString());
      if (s.errorCategory) {
        m.hset(
          this.key(s.sourceId),
          "lastFailureAt",
          s.at.toISOString(),
          "lastErrorCategory",
          s.errorCategory,
        );
      }
      await m.exec();
    } catch (err) {
      this.onError(err); // metrics never fail a search
    }
  }

  async read(sourceId: string): Promise<SourceMetrics> {
    try {
      return toMetrics(await this.redis.hgetall(this.key(sourceId)));
    } catch (err) {
      this.onError(err);
      return toMetrics({});
    }
  }
}
