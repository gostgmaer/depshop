-- Phase 5.3: notification system.
--  * Notification: category, critical flag, verified source (type + id),
--    per-user dedupe key, in-app link. Existing rows are backfilled from
--    their type and data (all came from alert evaluations or alert expiry).
--  * NotificationDelivery.sentTo: push subscriptions already delivered to.
--  * UserPreference: push switch, per-category channels, quiet hours, time zone.
--  * PushSubscription: user-owned Web Push subscriptions.
-- New NotificationType values are added but not used in this transaction.

CREATE TYPE "NotificationCategory" AS ENUM ('PRICE_ALERTS', 'SEARCH', 'ACCOUNT');
CREATE TYPE "NotificationSource" AS ENUM ('ALERT_EVALUATION', 'ALERT_EXPIRY', 'SEARCH', 'ACCOUNT');

ALTER TYPE "NotificationType" ADD VALUE 'SEARCH_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'SEARCH_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'NEW_SIGN_IN';

-- ── Notification ──────────────────────────────────────────────────────────
ALTER TABLE "Notification"
  ADD COLUMN "category" "NotificationCategory",
  ADD COLUMN "critical" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "link" TEXT,
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "sourceType" "NotificationSource";

UPDATE "Notification" n SET
  "category" = CASE WHEN n."type" = 'SYSTEM' THEN 'ACCOUNT'::"NotificationCategory"
                    ELSE 'PRICE_ALERTS'::"NotificationCategory" END,
  "sourceType" = CASE WHEN n."type" = 'ALERT_EXPIRED' THEN 'ALERT_EXPIRY'::"NotificationSource"
                      WHEN n."type" = 'SYSTEM' THEN 'ACCOUNT'::"NotificationSource"
                      ELSE 'ALERT_EVALUATION'::"NotificationSource" END,
  -- The evaluation that produced it (if still present), else the alert, else the row itself.
  "sourceId" = COALESCE(
    (SELECT e."id"::text FROM "AlertEvaluation" e WHERE e."notificationId" = n."id" LIMIT 1),
    n."data"->>'alertId',
    n."id"::text),
  "dedupeKey" = 'legacy:' || n."id"::text,
  "link" = CASE WHEN n."data" ? 'productId'
                THEN '/products/' || (n."data"->>'productId')
                     || COALESCE('?variant=' || (n."data"->>'variantId'), '')
                ELSE NULL END;

ALTER TABLE "Notification"
  ALTER COLUMN "category" SET NOT NULL,
  ALTER COLUMN "dedupeKey" SET NOT NULL,
  ALTER COLUMN "sourceId" SET NOT NULL,
  ALTER COLUMN "sourceType" SET NOT NULL;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_dedupeKey_nonempty" CHECK (length("dedupeKey") BETWEEN 1 AND 200),
  ADD CONSTRAINT "Notification_sourceId_nonempty" CHECK (length("sourceId") BETWEEN 1 AND 100),
  -- Only relative in-app paths (no external or protocol-relative links).
  ADD CONSTRAINT "Notification_link_relative" CHECK ("link" IS NULL OR ("link" LIKE '/%' AND "link" NOT LIKE '//%'));

CREATE INDEX "Notification_userId_category_createdAt_idx" ON "Notification"("userId", "category", "createdAt" DESC);
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- ── NotificationDelivery ──────────────────────────────────────────────────
ALTER TABLE "NotificationDelivery" ADD COLUMN "sentTo" UUID[] DEFAULT ARRAY[]::UUID[];

-- ── UserPreference ────────────────────────────────────────────────────────
ALTER TABLE "UserPreference"
  ADD COLUMN "notificationCategories" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "notifyPush" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quietHoursEnd" TEXT,
  ADD COLUMN "quietHoursStart" TEXT,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

ALTER TABLE "UserPreference"
  ADD CONSTRAINT "UserPreference_categories_object" CHECK (jsonb_typeof("notificationCategories") = 'object'),
  -- Both or neither (written so a single NULL can't make the check pass), HH:MM, different.
  ADD CONSTRAINT "UserPreference_quiet_hours" CHECK (
    ("quietHoursStart" IS NULL) = ("quietHoursEnd" IS NULL)
    AND ("quietHoursStart" IS NULL
         OR ("quietHoursStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             AND "quietHoursEnd" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             AND "quietHoursStart" <> "quietHoursEnd"))),
  ADD CONSTRAINT "UserPreference_timezone_nonempty" CHECK (length("timezone") BETWEEN 1 AND 64);

-- ── PushSubscription ──────────────────────────────────────────────────────
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expirationTime" TIMESTAMP(3),
    "userAgent" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PushSubscription_https" CHECK ("endpoint" LIKE 'https://%'),
    CONSTRAINT "PushSubscription_failures" CHECK ("failureCount" >= 0)
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
