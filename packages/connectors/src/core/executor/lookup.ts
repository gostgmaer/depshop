/**
 * Single-offer lookup for background price tracking. Same safety rails as
 * the search executor: source must be ACTIVE, its connector READY and able to
 * look products up; shared per-source rate limit (all processes, shared with
 * searches); circuit breaker; per-attempt timeout with AbortSignal; retries
 * with exponential backoff and full jitter; strict Zod validation; metrics.
 *
 * Concurrent lookups of the same listing in one process share one upstream
 * call (single-flight). It never invents data: a listing the connector can't
 * find is NOT_FOUND, a bad payload is INVALID, and nothing is cached.
 */
import { trace } from "@opentelemetry/api";
import type { ShoppingConnector } from "../interfaces/connector.js";
import { SingleFlight } from "../cache/response-cache.js";
import type { MetricsStore } from "../health/metrics.js";
import type { RateLimiter } from "../rate-limiter/rate-limiter.js";
import type { ConnectorRegistry } from "../registry/registry.js";
import type { SourceConfig, SourceConfigProvider } from "../registry/source-config.js";
import { CircuitBreakers } from "../retry/circuit-breaker.js";
import { DEFAULT_RETRY, attemptsOf, sleep as realSleep, withRetry } from "../retry/retry.js";
import { ConnectorError, type ErrorCategory, toConnectorError } from "../types/errors.js";
import { type NormalizedProduct, normalizedProductSchema } from "../types/schemas.js";

export type LookupStatus =
  /** The listing was returned and validated. */
  | "FOUND"
  /** The connector answered that the listing doesn't exist (any more). */
  | "NOT_FOUND"
  /** The connector answered with data that failed validation. */
  | "INVALID"
  /** The source can't be used for lookups now (inactive, not configured, no lookup capability). */
  | "SKIPPED"
  /** DealMind's own per-source budget is used up; retry after `retryAfterMs`. */
  | "RATE_LIMITED"
  /** Upstream failed after retries (or the circuit is open). */
  | "FAILED";

export interface LookupResult {
  status: LookupStatus;
  sourceSlug: string;
  item?: NormalizedProduct;
  errorCode?: string;
  errorMessage?: string;
  /** Whether the failure is worth retrying later (BullMQ retry). */
  retryable: boolean;
  retryAfterMs?: number;
  attempts: number;
  durationMs: number;
  /** Served by another identical in-flight lookup in this process. */
  deduplicated: boolean;
}

export interface LookupExecutorOptions {
  registry: ConnectorRegistry;
  sources: SourceConfigProvider;
  rateLimiter: RateLimiter;
  metrics: MetricsStore;
  breakers?: CircuitBreakers;
  allowMocks?: boolean;
  /**
   * Share of a source's per-minute budget tracking may use (0–1], so background
   * refreshes never starve interactive searches. The global source limit still
   * applies to the total.
   */
  trackingShare?: number;
  retry?: { baseDelayMs: number; maxDelayMs: number };
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const tracer = trace.getTracer("@dealmind/connectors");

export class ProductLookupExecutor {
  private readonly breakers: CircuitBreakers;
  private readonly inflight = new SingleFlight<LookupResult>();
  private readonly now: () => number;

  constructor(private readonly o: LookupExecutorOptions) {
    this.now = o.now ?? Date.now;
    this.breakers = o.breakers ?? new CircuitBreakers(this.now);
  }

  /** Slugs whose connector can look up a single listing (used by the scheduler). */
  lookupCapableSlugs(): string[] {
    return this.o.registry
      .list()
      .filter(
        (c) =>
          typeof c.getProduct === "function" &&
          c.getCapabilities().productLookup &&
          this.o.registry.isEnabled(c.id) &&
          (!c.isMock || this.o.allowMocks),
      )
      .map((c) => c.id);
  }

  async lookup(
    sourceSlug: string,
    externalId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<LookupResult> {
    const { promise, shared } = this.inflight.run(`${sourceSlug}:${externalId}`, () =>
      this.run(sourceSlug, externalId, opts.signal),
    );
    const r = await promise;
    return shared ? { ...r, deduplicated: true, attempts: 0 } : r;
  }

  private async run(slug: string, externalId: string, signal?: AbortSignal): Promise<LookupResult> {
    return tracer.startActiveSpan(`connector.lookup ${slug}`, async (span) => {
      const start = this.now();
      const done = async (r: Omit<LookupResult, "durationMs" | "deduplicated">) => {
        const result = { ...r, durationMs: this.now() - start, deduplicated: false };
        span.setAttribute("dealmind.source", slug);
        span.setAttribute("dealmind.lookup.status", result.status);
        span.end();
        if (result.status !== "SKIPPED" && result.status !== "RATE_LIMITED") {
          await this.o.metrics.record({
            sourceId: slug,
            outcome: result.status === "FAILED" ? "FAILED" : "SUCCEEDED",
            durationMs: result.durationMs,
            resultCount: result.status === "FOUND" ? 1 : 0,
            cached: false,
            ...(result.status === "FAILED" && result.errorCode
              ? { errorCategory: result.errorCode as ErrorCategory }
              : {}),
            at: new Date(this.now()),
          });
        }
        return result;
      };

      const source = (await this.o.sources.list()).find((s) => s.slug === slug);
      const connector = this.o.registry.get(slug);
      const skip = (code: string, message: string) =>
        done({
          status: "SKIPPED",
          sourceSlug: slug,
          errorCode: code,
          errorMessage: message,
          retryable: false,
          attempts: 0,
        });
      if (!source || source.status !== "ACTIVE")
        return skip("SOURCE_NOT_ACTIVE", `Source is ${source?.status ?? "unknown"}`);
      if (!connector) return skip("NO_CONNECTOR", "No connector registered");
      if (!this.o.registry.isEnabled(slug))
        return skip("CONNECTOR_DISABLED", "Connector disabled by an administrator");
      if (connector.isMock && !this.o.allowMocks)
        return skip("MOCK_NOT_ALLOWED", "Mock connectors are disabled");
      const readiness = connector.getReadiness();
      if (readiness.state !== "READY")
        return skip(readiness.state, "Connector is not ready (credentials or approval missing)");
      if (!connector.getCapabilities().productLookup || !connector.getProduct)
        return skip("NO_LOOKUP_CAPABILITY", "Connector can't look up a single listing");

      const settings = {
        failureThreshold: source.circuitFailureThreshold,
        openMs: source.circuitOpenSeconds * 1000,
      };
      if (!this.breakers.tryAcquire(slug, settings))
        return done({
          status: "FAILED",
          sourceSlug: slug,
          errorCode: "CIRCUIT_OPEN",
          errorMessage: "Circuit open: source failed repeatedly",
          retryable: true,
          retryAfterMs: settings.openMs,
          attempts: 0,
        });

      // Budget: the tracking share first, then the global source limit (shared with searches).
      const share = Math.min(1, Math.max(0.05, this.o.trackingShare ?? 0.5));
      const trackLimit = Math.max(1, Math.floor(source.rateLimitPerMinute * share));
      for (const [key, limit] of [
        [`track:${slug}`, trackLimit],
        [slug, source.rateLimitPerMinute],
      ] as const) {
        const d = await this.o.rateLimiter.acquire(key, limit);
        if (!d.allowed) {
          this.breakers.release(slug);
          return done({
            status: "RATE_LIMITED",
            sourceSlug: slug,
            errorCode: "RATE_LIMITED",
            errorMessage: `DealMind rate limit for ${slug} reached`,
            retryable: true,
            retryAfterMs: Math.max(250, d.retryAfterMs),
            attempts: 0,
          });
        }
      }

      try {
        const { value, attempts } = await withRetry(
          () => this.attempt(connector, source, externalId, signal),
          { ...DEFAULT_RETRY, ...this.o.retry, maxRetries: source.maxRetries },
          {
            deadline: start + source.timeoutMs * (source.maxRetries + 1) + 5_000,
            now: this.now,
            sleep: this.o.sleep ?? realSleep,
            ...(this.o.random ? { random: this.o.random } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        this.breakers.recordSuccess(slug);
        if (value === null)
          return done({ status: "NOT_FOUND", sourceSlug: slug, retryable: false, attempts });
        const parsed = normalizedProductSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.externalId !== externalId ||
          parsed.data.sourceId !== slug
        )
          return done({
            status: "INVALID",
            sourceSlug: slug,
            errorCode: "INVALID_RESPONSE",
            errorMessage: parsed.success
              ? "Listing returned for a different id"
              : parsed.error.issues
                  .slice(0, 3)
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; "),
            retryable: false,
            attempts,
          });
        return done({
          status: "FOUND",
          sourceSlug: slug,
          item: parsed.data,
          retryable: false,
          attempts,
        });
      } catch (raw) {
        const error = toConnectorError(raw);
        this.breakers.recordFailure(slug, settings);
        span.recordException(error);
        return done({
          status: "FAILED",
          sourceSlug: slug,
          errorCode: error.category,
          errorMessage: error.message.slice(0, 500),
          retryable: error.retryable,
          attempts: attemptsOf(raw),
        });
      }
    });
  }

  private async attempt(
    connector: ShoppingConnector,
    source: SourceConfig,
    externalId: string,
    outer?: AbortSignal,
  ) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new ConnectorError("TIMEOUT", `No response within ${source.timeoutMs} ms`);
        controller.abort(err);
        reject(err);
      }, source.timeoutMs);
    });
    try {
      return await Promise.race([
        connector.getProduct!(externalId, { signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}
