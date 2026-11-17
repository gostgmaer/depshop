/**
 * Typed background-job contracts shared by the API (producer) and
 * apps/worker (consumer). Payloads are validated with Zod on both sides.
 *
 * Idempotency: every job has a deterministic jobId derived from its payload.
 * BullMQ ignores an add() whose jobId already exists, so enqueueing the same
 * logical job twice (retries, double submits) does not run it twice.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const QueueName = {
  shoppingSearch: "shopping-search",
  priceRefresh: "price-refresh",
  alertEvaluation: "alert-evaluation",
  notificationDelivery: "notification-delivery",
  connectorHealth: "connector-health",
  /** Repeatable control jobs: the tracking scheduler tick and cleanup. */
  trackingControl: "tracking-control",
  billingControl: "billing-control",
  /** Jobs that exhausted their retries (kept for inspection; never re-run automatically). */
  deadLetter: "dead-letter",
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/** Run a user's shopping search across eligible sources. */
export const shoppingSearchJob = z.object({
  searchId: uuid,
  /** Owner of the search; the worker re-checks it against the row. */
  userId: uuid,
});
export type ShoppingSearchJob = z.infer<typeof shoppingSearchJob>;

/** Refresh the price of one tracked offer (scheduled, per-source rate limited). */
export const priceRefreshJob = z.object({
  offerId: uuid,
  /** Scheduling slot (ISO minute) so one refresh per offer per slot. */
  slot: z.string().min(1).max(32),
});
export type PriceRefreshJob = z.infer<typeof priceRefreshJob>;

/**
 * Evaluate the users' alerts affected by one global price check. Keyed by the
 * check, so a check is evaluated once however often the job is enqueued.
 */
export const alertEvaluationJob = z.object({
  checkId: uuid,
});
export type AlertEvaluationJob = z.infer<typeof alertEvaluationJob>;

/** Deliver one notification over one channel. */
export const notificationDeliveryJob = z.object({
  deliveryId: uuid,
});
export type NotificationDeliveryJob = z.infer<typeof notificationDeliveryJob>;

/** Tracking control: "schedule" (enqueue due offers) or "cleanup" (expire, prune). */
export const trackingControlJob = z.object({ task: z.enum(["schedule", "cleanup"]) }).strict();
export type TrackingControlJob = z.infer<typeof trackingControlJob>;

/** Billing housekeeping: "reconcile" (re-read due/stale subscriptions, expire checkouts). */
export const billingControlJob = z.object({ task: z.enum(["reconcile"]) }).strict();
export type BillingControlJob = z.infer<typeof billingControlJob>;

/** A job that exhausted its retries, recorded for operators. */
export const deadLetterJob = z.object({
  queue: z.string(),
  jobId: z.string(),
  name: z.string(),
  data: z.unknown(),
  failedReason: z.string().max(2000),
  attemptsMade: z.number().int(),
  failedAt: z.string(),
});
export type DeadLetterJob = z.infer<typeof deadLetterJob>;

/** Periodic health check of every registered connector (scheduled by the worker). */
export const connectorHealthJob = z.object({}).strict();
export type ConnectorHealthJob = z.infer<typeof connectorHealthJob>;

/**
 * BullMQ rejects custom job ids containing ":" (its key separator), so parts
 * are joined with "." and any ":" inside a part (e.g. ISO time slots) becomes "-".
 */
export function jobId(...parts: string[]): string {
  return parts.map((p) => p.replace(/:/g, "-")).join(".");
}

export const JOBS = {
  [QueueName.shoppingSearch]: {
    schema: shoppingSearchJob,
    jobId: (p: ShoppingSearchJob) => jobId("search", p.searchId),
  },
  [QueueName.priceRefresh]: {
    schema: priceRefreshJob,
    jobId: (p: PriceRefreshJob) => jobId("price", p.offerId, p.slot),
  },
  [QueueName.alertEvaluation]: {
    schema: alertEvaluationJob,
    jobId: (p: AlertEvaluationJob) => jobId("alerts", p.checkId),
  },
  [QueueName.notificationDelivery]: {
    schema: notificationDeliveryJob,
    jobId: (p: NotificationDeliveryJob) => jobId("delivery", p.deliveryId),
  },
  [QueueName.connectorHealth]: {
    schema: connectorHealthJob,
    jobId: (_p: ConnectorHealthJob) => "connector-health",
  },
  [QueueName.trackingControl]: {
    schema: trackingControlJob,
    jobId: (p: TrackingControlJob) => jobId("tracking", p.task),
  },
  [QueueName.billingControl]: {
    schema: billingControlJob,
    jobId: (p: BillingControlJob) => jobId("billing", p.task),
  },
  [QueueName.deadLetter]: {
    schema: deadLetterJob,
    jobId: (p: DeadLetterJob) => jobId("dead", p.queue, p.jobId, String(p.attemptsMade)),
  },
} as const;

export interface JobPayloads {
  [QueueName.shoppingSearch]: ShoppingSearchJob;
  [QueueName.priceRefresh]: PriceRefreshJob;
  [QueueName.alertEvaluation]: AlertEvaluationJob;
  [QueueName.notificationDelivery]: NotificationDeliveryJob;
  [QueueName.connectorHealth]: ConnectorHealthJob;
  [QueueName.trackingControl]: TrackingControlJob;
  [QueueName.billingControl]: BillingControlJob;
  [QueueName.deadLetter]: DeadLetterJob;
}

/** Custom backoff type: exponential with full jitter (registered by the worker). */
export const JITTER_BACKOFF = "jitter";

/**
 * Exponential backoff with full jitter: a random delay in [0, min(cap, base·2^(n-1))].
 * Spreads retries so a recovering marketplace isn't hit by a synchronized burst.
 */
export function jitterBackoff(
  attemptsMade: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attemptsMade - 1));
  return Math.floor(random() * exp);
}

/** Retries with exponential backoff; completed jobs are kept briefly for dedupe/inspection. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Redis flag set by the API when a user cancels a search (checked by the worker). */
export const searchCancelKey = (prefix: string, searchId: string) =>
  `${prefix}:search-cancel:${searchId}`;

/** Options for every notification delivery job (API and worker enqueue the same way). */
export const NOTIFICATION_DELIVERY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: JITTER_BACKOFF, delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 20_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
} as const;
