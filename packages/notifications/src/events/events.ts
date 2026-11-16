/**
 * Notification events. Each event names its verified source: the record
 * (alert evaluation, alert, search, audit entry) whose committed state
 * produced it. Producers build these after (or inside) the transaction that
 * records the source; nothing else may create a notification.
 */
import { z } from "zod";

const uuid = z.string().uuid();
const paise = z.number().int().nonnegative();
const product = z.object({
  id: uuid,
  name: z.string().min(1).max(300),
  variantId: uuid,
  variantLabel: z.string().max(200).nullable().optional(),
});

/** A user's price alert met its condition on a global price check. */
export const alertTriggeredEvent = z.object({
  kind: z.literal("alert.triggered"),
  userId: uuid,
  alertId: uuid,
  /** The price check that was evaluated (unique per alert): the verified source. */
  checkId: uuid,
  type: z.enum(["PRICE_DROP", "TARGET_PRICE_REACHED", "BACK_IN_STOCK", "PRICE_CHANGED"]),
  /** Headline and explanation computed by the alert rule engine. */
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  product,
  marketplace: z.string().min(1).max(100),
  pricePaise: paise,
  previousPricePaise: paise.nullable(),
  targetPricePaise: paise.nullable(),
  observedAt: z.string().datetime(),
  offerId: uuid,
  alertType: z.string(),
});

/** A user's alert reached its end date (worker cleanup). */
export const alertExpiredEvent = z.object({
  kind: z.literal("alert.expired"),
  userId: uuid,
  alertId: uuid,
  product,
  expiresAt: z.string().datetime(),
});

/** A user's search reached a terminal status. */
export const searchFinishedEvent = z.object({
  kind: z.literal("search.finished"),
  userId: uuid,
  searchId: uuid,
  status: z.enum(["COMPLETED", "PARTIAL", "FAILED"]),
  query: z.string().min(1).max(500),
  resultCount: z.number().int().nonnegative(),
});

/** The account's password was changed (confirmed by the IAM). */
export const passwordChangedEvent = z.object({
  kind: z.literal("account.password_changed"),
  userId: uuid,
  /** Audit log entry id of the change. */
  auditId: uuid,
  at: z.string().datetime(),
});

/** A sign-in from a device not seen on this account in the last 90 days. */
export const newSignInEvent = z.object({
  kind: z.literal("account.new_sign_in"),
  userId: uuid,
  /** The new session's id. */
  sessionId: uuid,
  at: z.string().datetime(),
  /** Short device description derived from the user agent ("Chrome on Windows"). */
  device: z.string().min(1).max(100),
});

export const notificationEvent = z.discriminatedUnion("kind", [
  alertTriggeredEvent,
  alertExpiredEvent,
  searchFinishedEvent,
  passwordChangedEvent,
  newSignInEvent,
]);
export type NotificationEvent = z.infer<typeof notificationEvent>;
export type AlertTriggeredEvent = z.infer<typeof alertTriggeredEvent>;
