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

/** Evaluate active alerts for a variant after new price data arrived. */
export const alertEvaluationJob = z.object({
  variantId: uuid,
  /** The snapshot that triggered evaluation (dedupes repeated triggers). */
  snapshotId: uuid,
});
export type AlertEvaluationJob = z.infer<typeof alertEvaluationJob>;

/** Deliver one notification over one channel. */
export const notificationDeliveryJob = z.object({
  deliveryId: uuid,
});
export type NotificationDeliveryJob = z.infer<typeof notificationDeliveryJob>;

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
    jobId: (p: AlertEvaluationJob) => jobId("alerts", p.variantId, p.snapshotId),
  },
  [QueueName.notificationDelivery]: {
    schema: notificationDeliveryJob,
    jobId: (p: NotificationDeliveryJob) => jobId("delivery", p.deliveryId),
  },
  [QueueName.connectorHealth]: {
    schema: connectorHealthJob,
    jobId: (_p: ConnectorHealthJob) => "connector-health",
  },
} as const;

export interface JobPayloads {
  [QueueName.shoppingSearch]: ShoppingSearchJob;
  [QueueName.priceRefresh]: PriceRefreshJob;
  [QueueName.alertEvaluation]: AlertEvaluationJob;
  [QueueName.notificationDelivery]: NotificationDeliveryJob;
  [QueueName.connectorHealth]: ConnectorHealthJob;
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
