-- Phase 2.3: connector framework metadata on ShoppingSource.
-- New statuses (added only; existing rows keep their status).
ALTER TYPE "SourceStatus" ADD VALUE IF NOT EXISTS 'PENDING_CREDENTIALS' BEFORE 'DISABLED';
ALTER TYPE "SourceStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' BEFORE 'DISABLED';

ALTER TABLE "ShoppingSource"
  ADD COLUMN "statusReason" TEXT,
  ADD COLUMN "lastSuccessAt" TIMESTAMP(3),
  ADD COLUMN "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN "circuitFailureThreshold" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "circuitOpenSeconds" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "ShoppingSource"
  ADD CONSTRAINT "ShoppingSource_cache_ttl_check" CHECK ("cacheTtlSeconds" BETWEEN 0 AND 86400),
  ADD CONSTRAINT "ShoppingSource_circuit_threshold_check" CHECK ("circuitFailureThreshold" BETWEEN 1 AND 100),
  ADD CONSTRAINT "ShoppingSource_circuit_open_check" CHECK ("circuitOpenSeconds" BETWEEN 1 AND 3600);
