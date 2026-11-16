/** Notification delivery queue (one job per delivery; the delivery id is the idempotency key). */
import { JITTER_BACKOFF } from "@dealmind/queue";
import type { JobsOptions } from "bullmq";

export const NOTIFICATION_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: JITTER_BACKOFF, delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 20_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};
export const NOTIFICATION_BACKOFF = { baseMs: 15_000, capMs: 30 * 60_000 };
