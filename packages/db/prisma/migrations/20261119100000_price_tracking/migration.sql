-- CreateEnum
CREATE TYPE "OfferTrackingState" AS ENUM ('ACTIVE', 'MISSING', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PriceCheckOutcome" AS ENUM ('UNCHANGED', 'PRICE_DECREASED', 'PRICE_INCREASED', 'OTHER_CHANGED', 'REAPPEARED', 'MISSING', 'INVALID', 'FAILED', 'SKIPPED', 'RATE_LIMITED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('TARGET_PRICE', 'PRICE_BELOW', 'PERCENT_DROP', 'HISTORICAL_LOW', 'PRICE_CHANGE', 'BACK_IN_STOCK');

-- CreateEnum
CREATE TYPE "AlertEvaluationOutcome" AS ENUM ('TRIGGERED', 'NOT_MET', 'COOLDOWN', 'SUPPRESSED', 'INSUFFICIENT_DATA');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PRICE_CHANGED';

-- DropIndex
DROP INDEX "PriceAlert_userId_variantId_sourceId_key";

-- AlterTable
ALTER TABLE "ShoppingSource" ADD COLUMN     "trackingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "trackingHighMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "trackingLowMinutes" INTEGER NOT NULL DEFAULT 720,
ADD COLUMN     "trackingNormalMinutes" INTEGER NOT NULL DEFAULT 180;

-- AlterTable
ALTER TABLE "ProductOffer" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "missingSince" TIMESTAMP(3),
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "trackingState" "OfferTrackingState" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "PriceAlert" ADD COLUMN     "baselinePricePaise" BIGINT,
ADD COLUMN     "cooldownMinutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "dropPercentBp" INTEGER,
ADD COLUMN     "historicalWindowDays" INTEGER,
ADD COLUMN     "lastEvaluatedAt" TIMESTAMP(3),
ADD COLUMN     "type" "AlertType" NOT NULL DEFAULT 'TARGET_PRICE',
ALTER COLUMN "targetPricePaise" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PriceCheck" (
    "id" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "outcome" "PriceCheckOutcome" NOT NULL,
    "previousPricePaise" BIGINT,
    "newPricePaise" BIGINT,
    "changePaise" BIGINT,
    "changeBp" INTEGER,
    "previousStock" "StockStatus",
    "newStock" "StockStatus",
    "snapshotId" UUID,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvaluation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "checkId" UUID,
    "offerId" UUID NOT NULL,
    "outcome" "AlertEvaluationOutcome" NOT NULL,
    "observedPricePaise" BIGINT,
    "reason" TEXT NOT NULL,
    "notificationId" UUID,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceCheck_offerId_checkedAt_idx" ON "PriceCheck"("offerId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "PriceCheck_checkedAt_idx" ON "PriceCheck"("checkedAt");

-- CreateIndex
CREATE INDEX "PriceCheck_sourceId_checkedAt_idx" ON "PriceCheck"("sourceId", "checkedAt");

-- CreateIndex
CREATE INDEX "AlertEvaluation_userId_evaluatedAt_idx" ON "AlertEvaluation"("userId", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "AlertEvaluation_alertId_evaluatedAt_idx" ON "AlertEvaluation"("alertId", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "AlertEvaluation_evaluatedAt_idx" ON "AlertEvaluation"("evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertEvaluation_alertId_checkId_key" ON "AlertEvaluation"("alertId", "checkId");

-- CreateIndex
CREATE INDEX "ProductOffer_trackingState_nextCheckAt_idx" ON "ProductOffer"("trackingState", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceAlert_userId_variantId_sourceId_type_key" ON "PriceAlert"("userId", "variantId", "sourceId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "PriceAlert_id_userId_key" ON "PriceAlert"("id", "userId");

-- AddForeignKey
ALTER TABLE "PriceCheck" ADD CONSTRAINT "PriceCheck_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ProductOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceCheck" ADD CONSTRAINT "PriceCheck_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ShoppingSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvaluation" ADD CONSTRAINT "AlertEvaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvaluation" ADD CONSTRAINT "AlertEvaluation_alertId_userId_fkey" FOREIGN KEY ("alertId", "userId") REFERENCES "PriceAlert"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvaluation" ADD CONSTRAINT "AlertEvaluation_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "PriceCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvaluation" ADD CONSTRAINT "AlertEvaluation_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ProductOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written constraints (Prisma can't express these) ──

-- One alert per user/variant/source/type; "any source" (NULL) is de-duplicated too.
DROP INDEX "PriceAlert_userId_variantId_sourceId_type_key";
CREATE UNIQUE INDEX "PriceAlert_userId_variantId_sourceId_type_key"
  ON "PriceAlert" ("userId", "variantId", "sourceId", "type") NULLS NOT DISTINCT;

-- Each alert type carries exactly the parameters it needs.
ALTER TABLE "PriceAlert" DROP CONSTRAINT "PriceAlert_target_check";
ALTER TABLE "PriceAlert"
  ADD CONSTRAINT "PriceAlert_target_check" CHECK (
    ("type" IN ('TARGET_PRICE', 'PRICE_BELOW')) = ("targetPricePaise" IS NOT NULL)
    AND ("targetPricePaise" IS NULL OR "targetPricePaise" > 0)
  ),
  ADD CONSTRAINT "PriceAlert_drop_check" CHECK (
    ("type" = 'PERCENT_DROP') = ("dropPercentBp" IS NOT NULL)
    AND ("dropPercentBp" IS NULL OR "dropPercentBp" BETWEEN 1 AND 9000)
  ),
  ADD CONSTRAINT "PriceAlert_window_check" CHECK (
    ("type" = 'HISTORICAL_LOW') = ("historicalWindowDays" IS NOT NULL)
    AND ("historicalWindowDays" IS NULL OR "historicalWindowDays" BETWEEN 7 AND 365)
  ),
  ADD CONSTRAINT "PriceAlert_baseline_check" CHECK ("baselinePricePaise" IS NULL OR "baselinePricePaise" > 0),
  ADD CONSTRAINT "PriceAlert_cooldown_check" CHECK ("cooldownMinutes" BETWEEN 0 AND 43200);

ALTER TABLE "ShoppingSource"
  ADD CONSTRAINT "ShoppingSource_tracking_intervals_check" CHECK (
    "trackingHighMinutes" BETWEEN 5 AND 10080
    AND "trackingNormalMinutes" BETWEEN 5 AND 10080
    AND "trackingLowMinutes" BETWEEN 5 AND 10080
    AND "trackingHighMinutes" <= "trackingNormalMinutes"
    AND "trackingNormalMinutes" <= "trackingLowMinutes"
  );

ALTER TABLE "ProductOffer"
  ADD CONSTRAINT "ProductOffer_failures_check" CHECK ("consecutiveFailures" >= 0);

-- A check's prices are real observations: never zero or negative.
ALTER TABLE "PriceCheck"
  ADD CONSTRAINT "PriceCheck_prices_check" CHECK (
    ("previousPricePaise" IS NULL OR "previousPricePaise" > 0)
    AND ("newPricePaise" IS NULL OR "newPricePaise" > 0)
    AND ("changePaise" IS NULL OR ("previousPricePaise" IS NOT NULL AND "newPricePaise" IS NOT NULL))
  ),
  ADD CONSTRAINT "PriceCheck_attempt_check" CHECK ("attempt" >= 1 AND "durationMs" >= 0);

ALTER TABLE "AlertEvaluation"
  ADD CONSTRAINT "AlertEvaluation_price_check" CHECK ("observedPricePaise" IS NULL OR "observedPricePaise" > 0);
