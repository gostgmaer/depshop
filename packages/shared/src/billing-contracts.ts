/**
 * Billing contracts (Phase 6.1): plans, the caller's subscription, checkout,
 * plan changes, payments, invoices and usage. Subscriptions belong to
 * individual users. Money is integer paise (INR).
 */
import { z } from "zod";
import { PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS } from "./plans.js";
import { PlanCode } from "./schemas.js";

const iso = z.string().datetime();
const paise = z.number().int().nonnegative();

export const BILLING_INTERVALS = ["MONTHLY", "ANNUAL"] as const;
export const billingInterval = z.enum(BILLING_INTERVALS);
export type BillingIntervalValue = (typeof BILLING_INTERVALS)[number];

export const SUBSCRIPTION_STATUSES = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELLED",
  "EXPIRED",
  "PAUSED",
] as const;
export type SubscriptionStatusValue = (typeof SUBSCRIPTION_STATUSES)[number];

export const PaidPlanCode = z.enum(["PRO", "BUSINESS"]);

export const planLimitsView = z.object(
  Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, z.number().int().nonnegative()])) as Record<
    (typeof PLAN_LIMIT_KEYS)[number],
    z.ZodNumber
  >,
);
export const planFeaturesView = z.object(
  Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<
    (typeof PLAN_FEATURE_KEYS)[number],
    z.ZodBoolean
  >,
);

export const planView = z.object({
  code: PlanCode,
  name: z.string(),
  description: z.string(),
  monthlyPricePaise: paise,
  annualPricePaise: paise.nullable(),
  limits: planLimitsView,
  features: planFeaturesView,
  /** Which intervals can be bought right now (provider plans configured). */
  purchasableIntervals: z.array(billingInterval),
});
export type PlanView = z.infer<typeof planView>;

export const subscriptionView = z.object({
  /** The subscribed plan (FREE when there is no paid subscription). */
  plan: planView,
  /** The plan whose limits apply right now (FREE after a lapse, even if `plan` is paid). */
  effectivePlan: PlanCode,
  status: z.enum(SUBSCRIPTION_STATUSES),
  interval: billingInterval.nullable(),
  currentPeriodStart: iso.nullable(),
  currentPeriodEnd: iso.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialEnd: iso.nullable(),
  /** PAST_DUE: paid access continues until this time while payment is retried. */
  graceUntil: iso.nullable(),
  /** Billing handled by this provider ("easydev-payments", "sandbox"), or null for FREE. */
  provider: z.string().nullable(),
  lastSyncedAt: iso.nullable(),
});
export type SubscriptionView = z.infer<typeof subscriptionView>;

/** Public: whether DealMind is free during its launch, and which plan everyone gets. */
export const launchOfferView = z.object({
  freeLaunch: z.object({ planCode: PlanCode, planName: z.string() }).nullable(),
});
export type LaunchOfferView = z.infer<typeof launchOfferView>;

// ── Checkout ──────────────────────────────────────────────────────────────

export const checkoutInput = z
  .object({ plan: PaidPlanCode, interval: billingInterval.default("MONTHLY") })
  .strict();

export const CHECKOUT_STATUSES = [
  "PENDING",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
] as const;

export const checkoutView = z.object({
  id: z.string().uuid(),
  status: z.enum(CHECKOUT_STATUSES),
  plan: PaidPlanCode,
  interval: billingInterval,
  /** Server-computed amount charged per interval. */
  amountPaise: paise,
  currency: z.literal("INR"),
  /** RAZORPAY (real, through the shared payment service) or SANDBOX (test mode, no money moves). */
  provider: z.enum(["RAZORPAY", "SANDBOX"]),
  /** Razorpay Checkout parameters (RAZORPAY only). */
  razorpay: z.object({ keyId: z.string(), subscriptionId: z.string() }).nullable(),
  failureReason: z.string().nullable(),
  expiresAt: iso,
  createdAt: iso,
});
export type CheckoutView = z.infer<typeof checkoutView>;

/** Razorpay Checkout's success handler fields, forwarded for server-side verification. */
export const confirmCheckoutInput = z.union([
  z
    .object({
      razorpayPaymentId: z.string().min(1).max(100),
      razorpaySubscriptionId: z.string().min(1).max(100),
      razorpaySignature: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ sandboxOutcome: z.enum(["success", "failure"]) }).strict(),
]);

export const changePlanInput = z
  .object({ plan: PlanCode, interval: billingInterval.default("MONTHLY") })
  .strict();

export const cancelSubscriptionInput = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

// ── History ───────────────────────────────────────────────────────────────

export const paymentView = z.object({
  id: z.string(),
  amountPaise: paise,
  currency: z.string(),
  status: z.string(),
  method: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: iso,
});
export type PaymentView = z.infer<typeof paymentView>;

export const invoiceView = z.object({
  id: z.string(),
  invoiceNumber: z.string().nullable(),
  amountPaise: paise,
  taxPaise: paise,
  totalPaise: paise,
  currency: z.string(),
  status: z.string(),
  issuedAt: iso.nullable(),
});
export type InvoiceView = z.infer<typeof invoiceView>;

// ── Usage ─────────────────────────────────────────────────────────────────

export const USAGE_ITEMS = [
  "searches",
  "activeAlerts",
  "watchlists",
  "trackedProducts",
  "exports",
] as const;

export const usageView = z.object({
  plan: PlanCode,
  items: z.array(
    z.object({
      key: z.enum(USAGE_ITEMS),
      label: z.string(),
      used: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      /** Metered items: when the counter resets; null for "at any time" limits. */
      resetsAt: iso.nullable(),
    }),
  ),
  historyDays: z.number().int().nonnegative(),
  compareItems: z.number().int().nonnegative(),
});
export type UsageView = z.infer<typeof usageView>;
