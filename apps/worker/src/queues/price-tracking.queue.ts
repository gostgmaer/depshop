/**
 * Price refresh queue (one job per marketplace offer and due slot).
 * Retries use the worker's "jitter" backoff (exponential, full jitter).
 */
import { JITTER_BACKOFF } from "@dealmind/queue";
import type { JobsOptions } from "bullmq";

export const PRICE_REFRESH_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: JITTER_BACKOFF, delay: 30_000 },
  removeOnComplete: { age: 6 * 3600, count: 20_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 20_000 },
};

/** Retry delays: 30 s base, doubling, at most 15 minutes (before jitter). */
export const PRICE_REFRESH_BACKOFF = { baseMs: 30_000, capMs: 15 * 60_000 };
