-- Phase 5.2: alert lifecycle, channels, expiry and change thresholds.
ALTER TABLE "PriceAlert" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "channels" "DeliveryChannel"[] DEFAULT ARRAY['IN_APP', 'EMAIL']::"DeliveryChannel"[],
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "minChangePaise" BIGINT,
ADD COLUMN     "repeat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "triggerCount" INTEGER NOT NULL DEFAULT 0;

-- Alerts created before this phase kept watching after a trigger (cooldown only):
-- keep that behaviour for them. New alerts default to one-shot.
UPDATE "PriceAlert" SET "repeat" = true;

ALTER TABLE "PriceAlert"
  ALTER COLUMN "channels" SET NOT NULL,
  ADD CONSTRAINT "PriceAlert_channels_check" CHECK (
    cardinality("channels") BETWEEN 1 AND 3
  ),
  ADD CONSTRAINT "PriceAlert_min_change_check" CHECK (
    "minChangePaise" IS NULL
    OR ("minChangePaise" > 0 AND "type" IN ('PRICE_CHANGE', 'PRICE_DROP'))
  ),
  ADD CONSTRAINT "PriceAlert_trigger_count_check" CHECK ("triggerCount" >= 0),
  -- A cancelled alert says when; nothing else carries a cancellation time.
  ADD CONSTRAINT "PriceAlert_cancelled_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

-- The worker scans active alerts per variant; expiry scans by time.
CREATE INDEX "PriceAlert_status_expiresAt_idx" ON "PriceAlert"("status", "expiresAt");
