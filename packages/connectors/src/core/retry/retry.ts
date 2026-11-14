/**
 * Retries with exponential backoff and full jitter:
 *   delay_n = random(0, min(maxDelay, baseDelay * 2^n))
 * Only retryable ConnectorErrors are retried; the overall deadline is never exceeded.
 */
import type { ConnectorError } from "../types/errors.js";
import { toConnectorError } from "../types/errors.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2_000 };

export interface RetryHooks {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Absolute deadline (ms since epoch); no retry starts after it. */
  deadline?: number;
  now?: () => number;
  onRetry?: (attempt: number, error: ConnectorError, delayMs: number) => void;
  signal?: AbortSignal;
}

export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<{ value: T; attempts: number }> {
  const doSleep = hooks.sleep ?? sleep;
  const now = hooks.now ?? Date.now;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { value: await fn(attempt), attempts: attempt + 1 };
    } catch (raw) {
      const error = toConnectorError(raw);
      if (!error.retryable || attempt >= policy.maxRetries)
        throw Object.assign(error, { attempts: attempt + 1 });
      const delay = Math.max(backoffDelay(attempt, policy, hooks.random), error.retryAfterMs ?? 0);
      if (hooks.deadline !== undefined && now() + delay >= hooks.deadline) {
        throw Object.assign(error, { attempts: attempt + 1 });
      }
      hooks.onRetry?.(attempt + 1, error, delay);
      await doSleep(delay, hooks.signal);
    }
  }
}

/** Number of attempts recorded on an error thrown by withRetry. */
export function attemptsOf(error: unknown): number {
  const n = (error as { attempts?: unknown }).attempts;
  return typeof n === "number" ? n : 1;
}
