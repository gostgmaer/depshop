/**
 * Event → in-app notification record (pure). The dedupe key makes one
 * notification per user per event: re-processing the same event is a no-op.
 */
import {
  CATEGORY_OF,
  type NotificationCategoryValue,
  type NotificationTypeValue,
  formatPaise,
  isCritical,
} from "@dealmind/shared";
import { type NotificationEvent, notificationEvent } from "../events/events.js";

export type NotificationSourceValue =
  "ALERT_EVALUATION" | "ALERT_EXPIRY" | "SEARCH" | "ACCOUNT" | "BILLING";

export interface NotificationDraft {
  userId: string;
  type: NotificationTypeValue;
  category: NotificationCategoryValue;
  critical: boolean;
  sourceType: NotificationSourceValue;
  sourceId: string;
  dedupeKey: string;
  title: string;
  body: string;
  /** Relative in-app path. */
  link: string | null;
  data: Record<string, unknown>;
}

const dateText = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const productLink = (p: { id: string; variantId: string }) =>
  `/products/${p.id}?variant=${p.variantId}`;

function draft(
  e: NotificationEvent,
  type: NotificationTypeValue,
  rest: Omit<NotificationDraft, "userId" | "type" | "category" | "critical">,
): NotificationDraft {
  return {
    userId: e.userId,
    type,
    category: CATEGORY_OF[type],
    critical: isCritical(type),
    ...rest,
    title: rest.title.slice(0, 200),
    body: rest.body.slice(0, 2000),
  };
}

/** Validates the event and builds its notification. Throws on an invalid event. */
export function buildNotification(input: NotificationEvent): NotificationDraft {
  const e = notificationEvent.parse(input);
  switch (e.kind) {
    case "alert.triggered":
      return draft(e, e.type, {
        sourceType: "ALERT_EVALUATION",
        sourceId: `${e.alertId}:${e.checkId}`,
        dedupeKey: `alert:${e.alertId}:check:${e.checkId}`,
        title: e.title,
        body: e.body,
        link: productLink(e.product),
        data: {
          alertId: e.alertId,
          alertType: e.alertType,
          checkId: e.checkId,
          offerId: e.offerId,
          productId: e.product.id,
          productName: e.product.name,
          variantId: e.product.variantId,
          variantLabel: e.product.variantLabel ?? null,
          marketplace: e.marketplace,
          pricePaise: e.pricePaise,
          previousPricePaise: e.previousPricePaise,
          targetPricePaise: e.targetPricePaise,
          observedAt: e.observedAt,
        },
      });
    case "alert.expired":
      return draft(e, "ALERT_EXPIRED", {
        sourceType: "ALERT_EXPIRY",
        sourceId: e.alertId,
        dedupeKey: `alert:${e.alertId}:expired`,
        title: `Your price alert for ${e.product.name} has ended`,
        body: `It reached the end date you set (${dateText.format(new Date(e.expiresAt))}) and is no longer checked. Create a new alert to keep watching.`,
        link: productLink(e.product),
        data: {
          alertId: e.alertId,
          productId: e.product.id,
          productName: e.product.name,
          variantId: e.product.variantId,
        },
      });
    case "search.finished": {
      const failed = e.status === "FAILED";
      const q = e.query.length > 80 ? `${e.query.slice(0, 79)}…` : e.query;
      return draft(e, failed ? "SEARCH_FAILED" : "SEARCH_COMPLETED", {
        sourceType: "SEARCH",
        sourceId: e.searchId,
        dedupeKey: `search:${e.searchId}:finished`,
        title: failed ? `Your search “${q}” couldn't be completed` : `Your search “${q}” is ready`,
        body: failed
          ? "Something went wrong while searching. You can try it again."
          : e.status === "PARTIAL"
            ? `${e.resultCount} result${e.resultCount === 1 ? "" : "s"} found. Some marketplaces didn't respond, so the results are partial.`
            : `${e.resultCount} result${e.resultCount === 1 ? "" : "s"} found.`,
        link: `/search/${e.searchId}`,
        data: { searchId: e.searchId, status: e.status, resultCount: e.resultCount },
      });
    }
    case "account.password_changed":
      return draft(e, "PASSWORD_CHANGED", {
        sourceType: "ACCOUNT",
        sourceId: e.auditId,
        dedupeKey: `account:password:${e.auditId}`,
        title: "Your password was changed",
        body: "Your DealMind password was changed and your other sessions were signed out. If this wasn't you, reset your password now.",
        link: "/settings/security",
        data: { at: e.at },
      });
    case "billing.subscription": {
      const end = e.periodEnd ? dateText.format(new Date(e.periodEnd)) : null;
      const copy: Record<typeof e.change, [NotificationTypeValue, string, string]> = {
        activated: [
          "SUBSCRIPTION_ACTIVATED",
          `Your ${e.planName} plan is active`,
          end ? `Payment confirmed. Your plan renews on ${end}.` : "Payment confirmed.",
        ],
        renewed: [
          "SUBSCRIPTION_RENEWED",
          `Your ${e.planName} plan renewed`,
          end ? `Payment received. Next renewal: ${end}.` : "Payment received.",
        ],
        payment_failed: [
          "PAYMENT_FAILED",
          `Payment for your ${e.planName} plan failed`,
          e.graceUntil
            ? `We'll retry the payment. Your ${e.planName} features stay on until ${dateText.format(new Date(e.graceUntil))}; update your payment method to avoid losing them.`
            : "We'll retry the payment. Update your payment method to keep your plan.",
        ],
        cancel_scheduled: [
          "SUBSCRIPTION_CANCELLED",
          `Your ${e.planName} plan will end`,
          end ? `It won't renew. You keep ${e.planName} features until ${end}.` : "It won't renew.",
        ],
        ended: [
          "SUBSCRIPTION_ENDED",
          `Your ${e.planName} plan has ended`,
          "You're on the Free plan now. You can upgrade again any time.",
        ],
        refund: [
          "REFUND_UPDATED",
          "Your refund was updated",
          "See your billing page for the payment and refund status.",
        ],
      };
      const [type, title, body] = copy[e.change];
      return draft(e, type, {
        sourceType: "BILLING",
        sourceId: e.sourceKey,
        dedupeKey: `billing:${e.change}:${e.sourceKey}`,
        title,
        body,
        link: "/billing",
        data: { subscriptionId: e.subscriptionId, change: e.change, periodEnd: e.periodEnd },
      });
    }
    case "account.new_sign_in":
      return draft(e, "NEW_SIGN_IN", {
        sourceType: "ACCOUNT",
        sourceId: e.sessionId,
        dedupeKey: `account:sign-in:${e.sessionId}`,
        title: "New sign-in to your account",
        body: `Signed in on ${e.device}. If this wasn't you, sign out that session and change your password.`,
        link: "/settings/security",
        data: { at: e.at, device: e.device, sessionId: e.sessionId },
      });
  }
}

/** Money helper for templates (integer paise → "₹24,999"). */
export const inr = (p: number | null | undefined) =>
  typeof p === "number" ? formatPaise(p) : null;
