-- Phase 6.2: affiliate click attribution, provider-reported conversions and payouts.
-- Affiliate data stays separate from subscription billing.

-- CreateEnum
CREATE TYPE "AffiliateRedirectStatus" AS ENUM ('REDIRECTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AffiliatePayoutStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterEnum
ALTER TYPE "ConversionStatus" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "AffiliateClick" ADD COLUMN     "destinationDomain" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "productId" UUID,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'direct',
ADD COLUMN     "redirectStatus" "AffiliateRedirectStatus" NOT NULL DEFAULT 'REDIRECTED',
ADD COLUMN     "referrerDomain" TEXT,
ADD COLUMN     "surface" TEXT,
ADD COLUMN     "trackingId" TEXT,
ADD COLUMN     "variantId" UUID;

-- AlterTable
ALTER TABLE "AffiliateConversion" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "orderedAt" TIMESTAMP(3),
ADD COLUMN     "payoutId" UUID,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "providerStatus" TEXT;

-- CreateTable
CREATE TABLE "AffiliatePayout" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceId" UUID,
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "AffiliatePayoutStatus" NOT NULL DEFAULT 'PENDING',
    "payoutReference" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliatePayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AffiliatePayout_provider_payoutReference_key" ON "AffiliatePayout"("provider", "payoutReference");

-- CreateIndex
CREATE INDEX "AffiliateClick_createdAt_idx" ON "AffiliateClick"("createdAt");

-- CreateIndex
CREATE INDEX "AffiliateConversion_status_reportedAt_idx" ON "AffiliateConversion"("status", "reportedAt");

-- AddForeignKey
ALTER TABLE "AffiliateConversion" ADD CONSTRAINT "AffiliateConversion_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "AffiliatePayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliatePayout" ADD CONSTRAINT "AffiliatePayout_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ShoppingSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written constraints (Phase 6.2) ─────────────────────────────────
ALTER TABLE "AffiliatePayout"
  ADD CONSTRAINT "AffiliatePayout_amount_check" CHECK ("amountPaise" >= 0),
  ADD CONSTRAINT "AffiliatePayout_currency_check" CHECK ("currency" = 'INR'),
  ADD CONSTRAINT "AffiliatePayout_paid_check" CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL));
ALTER TABLE "AffiliateConversion"
  ADD CONSTRAINT "AffiliateConversion_currency_check" CHECK ("currency" = 'INR');
-- Only the referrer host is kept, never a full URL.
ALTER TABLE "AffiliateClick"
  ADD CONSTRAINT "AffiliateClick_referrer_host_check" CHECK ("referrerDomain" IS NULL OR "referrerDomain" !~ '[/?#]');
