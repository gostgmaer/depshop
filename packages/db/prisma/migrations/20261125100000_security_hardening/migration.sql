-- Phase 7.1: indexes for the hourly personal-data retention cleanup
-- (sessions 30 days after ending, deliveries 90 days, notifications and
-- finished searches 365 days). Without them each run scans whole tables.

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_createdAt_idx" ON "NotificationDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "Search_createdAt_idx" ON "Search"("createdAt");

-- CreateIndex
CREATE INDEX "UserSession_revokedAt_idx" ON "UserSession"("revokedAt");
