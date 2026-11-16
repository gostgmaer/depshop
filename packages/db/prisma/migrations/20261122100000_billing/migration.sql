-- Phase 6.1: subscriptions, checkout, usage counters, billing webhooks.
-- Data-preserving: CANCELED is renamed (not dropped), providerRef is renamed.
-- New enum values are added but not used in this migration.

-- ── Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "CheckoutStatus" AS ENUM ('PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "BillingEventProcessing" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

ALTER TYPE "SubscriptionStatus" RENAME VALUE 'CANCELED' TO 'CANCELLED';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'TRIALING' BEFORE 'ACTIVE';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED';

ALTER TYPE "BillingEventType" ADD VALUE 'WEBHOOK_RECEIVED';
ALTER TYPE "UsageMetric" ADD VALUE 'EXPORT';
ALTER TYPE "NotificationCategory" ADD VALUE 'BILLING';
ALTER TYPE "NotificationSource" ADD VALUE 'BILLING';
ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_ACTIVATED' BEFORE 'SYSTEM';
ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_RENEWED' BEFORE 'SYSTEM';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_FAILED' BEFORE 'SYSTEM';
ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_CANCELLED' BEFORE 'SYSTEM';
ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_ENDED' BEFORE 'SYSTEM';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_UPDATED' BEFORE 'SYSTEM';

-- ── SubscriptionPlan ──────────────────────────────────────────────────────
ALTER TABLE "SubscriptionPlan"
  ADD COLUMN "annualPricePaise" BIGINT,
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "features" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "providerPlanIds" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT "SubscriptionPlan_prices_check" CHECK ("monthlyPricePaise" >= 0 AND ("annualPricePaise" IS NULL OR "annualPricePaise" > 0)),
  ADD CONSTRAINT "SubscriptionPlan_json_objects_check" CHECK (
    jsonb_typeof("limits") = 'object' AND jsonb_typeof("features") = 'object' AND jsonb_typeof("providerPlanIds") = 'object');

-- ── Subscription ──────────────────────────────────────────────────────────
ALTER TABLE "Subscription" RENAME COLUMN "providerRef" TO "providerSubscriptionId";
ALTER INDEX "Subscription_provider_providerRef_key" RENAME TO "Subscription_provider_providerSubscriptionId_key";
ALTER TABLE "Subscription"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "interval" "BillingInterval",
  ADD COLUMN "lastSyncedAt" TIMESTAMP(3),
  ADD COLUMN "pastDueSince" TIMESTAMP(3),
  ADD COLUMN "trialEnd" TIMESTAMP(3);
-- A paid plan always names its provider subscription and interval.
ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_paid_provider_check" CHECK (
    "planCode" = 'FREE' OR ("provider" IS NOT NULL AND "providerSubscriptionId" IS NOT NULL AND "interval" IS NOT NULL));
CREATE INDEX "Subscription_status_lastSyncedAt_idx" ON "Subscription"("status", "lastSyncedAt");

-- ── CheckoutSession ───────────────────────────────────────────────────────
CREATE TABLE "CheckoutSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planCode" "PlanCode" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider" TEXT NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'PENDING',
    "providerTransactionId" TEXT,
    "providerAttemptId" TEXT,
    "providerKeyId" TEXT,
    "providerOrderId" TEXT,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CheckoutSession_amount_check" CHECK ("amountPaise" > 0),
    CONSTRAINT "CheckoutSession_currency_check" CHECK ("currency" = 'INR'),
    CONSTRAINT "CheckoutSession_paid_plan_check" CHECK ("planCode" <> 'FREE')
);
CREATE INDEX "CheckoutSession_userId_createdAt_idx" ON "CheckoutSession"("userId", "createdAt" DESC);
CREATE INDEX "CheckoutSession_status_expiresAt_idx" ON "CheckoutSession"("status", "expiresAt");
CREATE UNIQUE INDEX "CheckoutSession_id_userId_key" ON "CheckoutSession"("id", "userId");
CREATE UNIQUE INDEX "CheckoutSession_provider_providerOrderId_key" ON "CheckoutSession"("provider", "providerOrderId");
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_planCode_fkey" FOREIGN KEY ("planCode") REFERENCES "SubscriptionPlan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── UsageCounter ──────────────────────────────────────────────────────────
CREATE TABLE "UsageCounter" (
    "userId" UUID NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("userId","metric","periodStart"),
    CONSTRAINT "UsageCounter_quantity_check" CHECK ("quantity" >= 0)
);
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BillingEvent (verified webhook ledger) ───────────────────────────────
ALTER TABLE "BillingEvent"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "eventType" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "processingStatus" "BillingEventProcessing" NOT NULL DEFAULT 'RECEIVED',
  ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "BillingEvent"
  ADD CONSTRAINT "BillingEvent_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "BillingEvent_processed_check" CHECK (("processingStatus" IN ('PROCESSED', 'IGNORED')) = ("processedAt" IS NOT NULL));
