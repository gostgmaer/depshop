/** Alert evaluation queue (one job per global price check). */
import { JITTER_BACKOFF } from "@dealmind/queue";
import type { JobsOptions } from "bullmq";

export const ALERT_EVALUATION_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: JITTER_BACKOFF, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 20_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};
export const ALERT_EVALUATION_BACKOFF = { baseMs: 5_000, capMs: 5 * 60_000 };
