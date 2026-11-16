/** Notification delivery queue (one job per delivery; the delivery id is the idempotency key). */
import { NOTIFICATION_DELIVERY_JOB_OPTIONS } from "@dealmind/queue";
import type { JobsOptions } from "bullmq";

export const NOTIFICATION_JOB_OPTIONS: JobsOptions = { ...NOTIFICATION_DELIVERY_JOB_OPTIONS };
export const NOTIFICATION_BACKOFF = { baseMs: 15_000, capMs: 30 * 60_000 };
