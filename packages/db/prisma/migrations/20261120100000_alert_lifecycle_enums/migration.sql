-- Phase 5.2 enum values. In their own migration: PostgreSQL can't use a value
-- added by ALTER TYPE inside the same transaction (the constraints migration does).
ALTER TYPE "AlertStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "AlertStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "AlertType" ADD VALUE 'PRICE_DROP';
ALTER TYPE "NotificationType" ADD VALUE 'ALERT_EXPIRED';
