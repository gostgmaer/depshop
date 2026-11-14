/**
 * Parallel search executor: runs one request against every eligible source.
 *
 *  - bounded concurrency (worker pool), failure-isolated (allSettled semantics:
 *    one source failing never cancels or hides another's results);
 *  - per source: circuit breaker → shared response cache → single-flight
 *    dedup → shared rate limit → retries (exponential backoff + full jitter)
 *    → per-attempt timeout with AbortSignal → strict Zod validation;
 *  - every source gets an outcome (SUCCEEDED / FAILED / TIMED_OUT / SKIPPED
 *    with a reason), duration, attempts and result count, plus metrics.
 *
 * It never invents data: a source that can't be searched is reported as such.
 */
import { trace } from "@opentelemetry/api";
import type { ShoppingConnector } from "../interfaces/connector.js";
import type { ResponseCache } from "../cache/response-cache.js";
import { SingleFlight, requestFingerprint } from "../cache/response-cache.js";
import type { MetricsStore } from "../health/metrics.js";
import type { RateLimiter } from "../rate-limiter/rate-limiter.js";
import {
  type ConnectorRegistry,
  type EligibleSource,
  type SkipReason,
} from "../registry/registry.js";
import type {
  SourceConfig,
  SourceConfigProvider,
  SourceStatusStore,
} from "../registry/source-config.js";
import { CircuitBreakers } from "../retry/circuit-breaker.js";
import { DEFAULT_RETRY, attemptsOf, sleep as realSleep, withRetry } from "../retry/retry.js";
import { ConnectorError, type ErrorCategory, toConnectorError } from "../types/errors.js";
import {
  type ConnectorSearchResult,
  type NormalizedProduct,
  type ShoppingSearchRequest,
  type ValidSearchRequest,
  connectorSearchResultSchema,
  normalizedProductSchema,
  shoppingSearchRequestSchema,
} from "../types/schemas.js";

export type SourceRunStatus = "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "SKIPPED";

export interface SourceRunResult {
  sourceId: string; // slug
  sourceDbId: string;
  sourceName: string;
  isMock: boolean;
  status: SourceRunStatus;
  items: NormalizedProduct[];
  resultCount: number;
  rejectedItems: number;
  durationMs: number;
  attempts: number;
  cached: boolean;
  /** Served by another identical in-flight request (deduplicated). */
  deduplicated: boolean;
  errorCode?: ErrorCategory | SkipReason;
  errorMessage?: string;
}

export interface SearchExecution {
  request: ValidSearchRequest;
  fingerprint: string;
  startedAt: Date;
  durationMs: number;
  /** COMPLETED: every searched source succeeded; PARTIAL: some failed; FAILED: all failed;
   *  NO_SOURCES: nothing was eligible to search. */
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "NO_SOURCES";
  sources: SourceRunResult[];
  items: NormalizedProduct[];
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface ExecutorOptions {
  registry: ConnectorRegistry;
  sources: SourceConfigProvider;
  rateLimiter: RateLimiter;
  cache: ResponseCache;
  metrics: MetricsStore;
  statusStore?: SourceStatusStore;
  breakers?: CircuitBreakers;
  logger?: Logger;
  /** Max sources searched at the same time. */
  concurrency?: number;
  /** Mock connectors run only when true (development/tests; never production). */
  allowMocks?: boolean;
  /** Longest a source may wait for its rate-limit window before failing. */
  maxRateLimitWaitMs?: number;
  /** Hard cap on one source's total time including retries. */
  maxSourceBudgetMs?: number;
  retry?: { baseDelayMs: number; maxDelayMs: number };
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

type CallOutcome = ConnectorSearchResult & { attempts: number; rateLimited: boolean };

const tracer = trace.getTracer("@dealmind/connectors");

/** Runs fn over items with at most `limit` in flight; never rejects. */
export async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export class ParallelSearchExecutor {
  private readonly breakers: CircuitBreakers;
  private readonly inflight = new SingleFlight<CallOutcome>();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly lastSuccessWrite = new Map<string, number>();

  constructor(private readonly o: ExecutorOptions) {
    this.log = o.logger ?? noopLogger;
    this.now = o.now ?? Date.now;
    this.breakers =
      o.breakers ??
      new CircuitBreakers(this.now, (id, from, to) => {
        this.log.warn({ source: id, from, to }, "circuit breaker transition");
        if (to === "OPEN")
          void this.o.statusStore?.recordHealth(
            id,
            "DOWN",
            "Circuit open after repeated failures",
            new Date(this.now()),
          );
        if (to === "CLOSED" && from !== "CLOSED")
          void this.o.statusStore?.recordHealth(id, "HEALTHY", null, new Date(this.now()));
      });
  }

  get circuitBreakers(): CircuitBreakers {
    return this.breakers;
  }

  /** Number of distinct upstream calls currently in flight (for tests/metrics). */
  get inflightCount(): number {
    return this.inflight.size;
  }

  async run(
    input: ShoppingSearchRequest,
    opts: { only?: string[]; signal?: AbortSignal } = {},
  ): Promise<SearchExecution> {
    const request = shoppingSearchRequestSchema.parse(input);
    const fingerprint = requestFingerprint(request);
    const startedAt = this.now();
    const all = await this.o.sources.list();
    const { eligible, skipped } = this.o.registry.eligible(all, request, {
      ...(opts.only ? { only: opts.only } : {}),
      allowMocks: this.o.allowMocks ?? false,
    });

    const settled = await mapBounded(eligible, this.o.concurrency ?? 4, (e) =>
      this.runSource(e, request, fingerprint, opts.signal),
    );
    const searched = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : this.failure(eligible[i]!, toConnectorError(r.reason), 0, 1),
    );
    const skippedRuns = skipped
      .filter((s) => s.reason !== "NOT_REQUESTED")
      .map((s): SourceRunResult => ({
        ...this.base(s.source, this.o.registry.get(s.source.slug)),
        status: "SKIPPED",
        errorCode: s.reason,
        ...(s.detail ? { errorMessage: s.detail } : {}),
      }));
    for (const s of skippedRuns) {
      void this.o.metrics.record({
        sourceId: s.sourceId,
        outcome: "SKIPPED",
        durationMs: 0,
        resultCount: 0,
        cached: false,
        at: new Date(this.now()),
      });
    }

    const ok = searched.filter((s) => s.status === "SUCCEEDED");
    const status: SearchExecution["status"] =
      searched.length === 0
        ? "NO_SOURCES"
        : ok.length === searched.length
          ? "COMPLETED"
          : ok.length > 0
            ? "PARTIAL"
            : "FAILED";
    const execution: SearchExecution = {
      request,
      fingerprint,
      startedAt: new Date(startedAt),
      durationMs: this.now() - startedAt,
      status,
      sources: [...searched, ...skippedRuns],
      items: ok.flatMap((s) => s.items),
    };
    this.log.info(
      {
        fingerprint,
        status,
        durationMs: execution.durationMs,
        sources: execution.sources.map((s) => ({
          id: s.sourceId,
          status: s.status,
          n: s.resultCount,
          ms: s.durationMs,
          err: s.errorCode,
        })),
      },
      "search execution finished",
    );
    return execution;
  }

  private base(source: SourceConfig, connector?: ShoppingConnector) {
    return {
      sourceId: source.slug,
      sourceDbId: source.id,
      sourceName: source.name,
      isMock: connector?.isMock ?? false,
      items: [] as NormalizedProduct[],
      resultCount: 0,
      rejectedItems: 0,
      durationMs: 0,
      attempts: 0,
      cached: false,
      deduplicated: false,
    };
  }

  private failure(
    e: EligibleSource,
    error: ConnectorError,
    durationMs: number,
    attempts: number,
  ): SourceRunResult {
    return {
      ...this.base(e.source, e.connector),
      status: error.category === "TIMEOUT" ? "TIMED_OUT" : "FAILED",
      durationMs,
      attempts,
      errorCode: error.category,
      errorMessage: error.message.slice(0, 500),
    };
  }

  private async runSource(
    e: EligibleSource,
    request: ValidSearchRequest,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<SourceRunResult> {
    return tracer.startActiveSpan(`connector.search ${e.source.slug}`, async (span) => {
      const start = this.now();
      const settings = {
        failureThreshold: e.source.circuitFailureThreshold,
        openMs: e.source.circuitOpenSeconds * 1000,
      };
      let result: SourceRunResult;
      let rateLimited = false;
      try {
        if (!this.breakers.tryAcquire(e.source.slug, settings)) {
          throw new ConnectorError(
            "CIRCUIT_OPEN",
            "Circuit open: source failed repeatedly; skipping until it recovers",
            {
              retryable: false,
            },
          );
        }
        const cached = await this.o.cache.get(e.source.slug, fingerprint);
        if (cached) {
          this.breakers.release(e.source.slug);
          result = {
            ...this.base(e.source, e.connector),
            status: "SUCCEEDED",
            items: cached.items,
            resultCount: cached.items.length,
            rejectedItems: cached.rejectedItems,
            durationMs: this.now() - start,
            cached: true,
          };
        } else {
          const { promise, shared } = this.inflight.run(
            `${e.source.slug}:${fingerprint}`,
            async () => {
              const outcome = await this.call(e, request, start, signal);
              await this.o.cache.set(e.source.slug, fingerprint, outcome, e.source.cacheTtlSeconds);
              return outcome;
            },
          );
          const outcome = await promise;
          rateLimited = outcome.rateLimited;
          if (!shared) {
            this.breakers.recordSuccess(e.source.slug);
            await this.noteSuccess(e.source.slug);
          } else {
            this.breakers.release(e.source.slug);
          }
          result = {
            ...this.base(e.source, e.connector),
            status: "SUCCEEDED",
            items: outcome.items,
            resultCount: outcome.items.length,
            rejectedItems: outcome.rejectedItems,
            durationMs: this.now() - start,
            attempts: shared ? 0 : outcome.attempts,
            deduplicated: shared,
          };
        }
      } catch (raw) {
        const error = toConnectorError(raw);
        rateLimited ||= error.category === "RATE_LIMITED";
        // Our own rate limiting and an open circuit are not evidence the source is broken.
        if (error.category === "CIRCUIT_OPEN" || isLocalRateLimit(error)) {
          this.breakers.release(e.source.slug);
        } else {
          this.breakers.recordFailure(e.source.slug, settings);
        }
        result = this.failure(e, error, this.now() - start, attemptsOf(raw));
        this.log.warn(
          { source: e.source.slug, category: error.category, attempts: result.attempts },
          error.message,
        );
        span.recordException(error);
      }
      span.setAttribute("dealmind.source", e.source.slug);
      span.setAttribute("dealmind.status", result.status);
      span.setAttribute("dealmind.results", result.resultCount);
      span.end();
      await this.o.metrics.record({
        sourceId: e.source.slug,
        outcome: result.status,
        durationMs: result.durationMs,
        resultCount: result.resultCount,
        cached: result.cached,
        ...(result.status !== "SUCCEEDED" && result.errorCode
          ? { errorCategory: result.errorCode as ErrorCategory }
          : {}),
        rateLimited,
        at: new Date(this.now()),
      });
      return result;
    });
  }

  /** Persists lastSuccessAt at most once a minute per source. */
  private async noteSuccess(slug: string): Promise<void> {
    const t = this.now();
    if (!this.o.statusStore || t - (this.lastSuccessWrite.get(slug) ?? -Infinity) < 60_000) return;
    this.lastSuccessWrite.set(slug, t);
    try {
      await this.o.statusStore.recordSuccess(slug, new Date(t));
    } catch (err) {
      // Bookkeeping never fails a successful search.
      this.log.error(
        { source: slug, err: (err as Error).message },
        "could not record source success",
      );
    }
  }

  private async call(
    e: EligibleSource,
    request: ValidSearchRequest,
    start: number,
    signal?: AbortSignal,
  ): Promise<CallOutcome> {
    const { source, connector } = e;
    const budget = Math.min(
      source.timeoutMs * (source.maxRetries + 1) + 5_000,
      this.o.maxSourceBudgetMs ?? 30_000,
    );
    const deadline = start + budget;
    let rateLimited = false;
    const sleep = this.o.sleep ?? realSleep;
    const { value, attempts } = await withRetry(
      async () => {
        // Shared per-source rate limit (all processes).
        for (;;) {
          const d = await this.o.rateLimiter.acquire(source.slug, source.rateLimitPerMinute);
          if (d.allowed) break;
          rateLimited = true;
          const maxWait = this.o.maxRateLimitWaitMs ?? 2_000;
          if (d.retryAfterMs > maxWait || this.now() + d.retryAfterMs >= deadline) {
            throw Object.assign(
              new ConnectorError(
                "RATE_LIMITED",
                `DealMind rate limit of ${source.rateLimitPerMinute}/min reached`,
                {
                  retryable: false,
                },
              ),
              { local: true },
            );
          }
          await sleep(d.retryAfterMs, signal);
        }
        return this.attempt(connector, source, request, signal);
      },
      { ...DEFAULT_RETRY, ...this.o.retry, maxRetries: source.maxRetries },
      {
        deadline,
        now: this.now,
        sleep,
        ...(this.o.random ? { random: this.o.random } : {}),
        ...(signal ? { signal } : {}),
        onRetry: (attempt, err, delayMs) =>
          this.log.warn(
            { source: source.slug, attempt, category: err.category, delayMs },
            "retrying connector call",
          ),
      },
    );
    return { ...value, attempts, rateLimited };
  }

  /** One attempt: timeout + abort, then strict validation of the response. */
  private async attempt(
    connector: ShoppingConnector,
    source: SourceConfig,
    request: ValidSearchRequest,
    outer?: AbortSignal,
  ): Promise<ConnectorSearchResult> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new ConnectorError("TIMEOUT", `No response within ${source.timeoutMs} ms`);
        controller.abort(err);
        reject(err);
      }, source.timeoutMs);
    });
    try {
      // Race as well as abort: a connector that ignores its signal still times out.
      const raw = await Promise.race([
        connector.search(request, { signal: controller.signal }),
        timeout,
      ]);
      return validateResult(raw, source.slug, request.limit);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** True for our own (shared) rate limiter rejecting a call, as opposed to an upstream 429. */
function isLocalRateLimit(error: ConnectorError): boolean {
  return (
    error.category === "RATE_LIMITED" &&
    (error as ConnectorError & { local?: boolean }).local === true
  );
}

/**
 * Validates a raw connector result. A malformed envelope (or one claiming to
 * be another source) is an INVALID_RESPONSE; individual invalid items are
 * dropped and counted, never passed on.
 */
export function validateResult(raw: unknown, slug: string, limit: number): ConnectorSearchResult {
  const env = connectorSearchResultSchema.safeParse(raw);
  if (!env.success) {
    throw new ConnectorError(
      "INVALID_RESPONSE",
      `Malformed connector response: ${env.error.issues[0]?.message ?? "invalid"}`,
      {
        retryable: false,
      },
    );
  }
  if (env.data.sourceId !== slug) {
    throw new ConnectorError("INVALID_RESPONSE", `Response claims source "${env.data.sourceId}"`, {
      retryable: false,
    });
  }
  const items: NormalizedProduct[] = [];
  let rejected = 0;
  for (const item of env.data.items) {
    const parsed = normalizedProductSchema.safeParse(item);
    if (parsed.success && parsed.data.sourceId === slug) items.push(parsed.data);
    else rejected += 1;
  }
  return {
    sourceId: slug,
    items: items.slice(0, limit),
    ...(env.data.totalAvailable !== undefined ? { totalAvailable: env.data.totalAvailable } : {}),
    fetchedAt: env.data.fetchedAt,
    rejectedItems: rejected,
  };
}
