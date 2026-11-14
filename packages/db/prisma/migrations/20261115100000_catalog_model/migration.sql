-- Phase 2.2: product catalog model.
--
-- Hand-written so that EVERY existing value is preserved: columns are renamed
-- (never dropped and re-added), new required columns are backfilled from
-- existing data, and money columns are widened INT -> BIGINT in place.
-- Existing CHECK constraints follow renamed columns automatically.

-- ── Enums ────────────────────────────────────────────────────────────────
ALTER TYPE "Availability" RENAME TO "StockStatus";
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'MAINTENANCE');
CREATE TYPE "MatchMethod" AS ENUM ('IDENTIFIER', 'MODEL_NUMBER', 'NORMALIZED_TITLE', 'FUZZY_TITLE', 'MANUAL', 'NEW_PRODUCT');
CREATE TYPE "MatchReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- ── Category ─────────────────────────────────────────────────────────────
ALTER TABLE "Category"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "imageUrl" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- ── Product ──────────────────────────────────────────────────────────────
ALTER TABLE "Product" RENAME COLUMN "title" TO "name";
ALTER TABLE "Product" RENAME COLUMN "model" TO "modelNumber";
ALTER TABLE "Product" RENAME COLUMN "launchedAt" TO "launchDate";
ALTER TABLE "Product" RENAME COLUMN "specs" TO "specifications";
ALTER INDEX "Product_title_trgm_idx" RENAME TO "Product_name_trgm_idx";
ALTER INDEX "Product_launchedAt_idx" RENAME TO "Product_launchDate_idx";

ALTER TABLE "Product"
  ADD COLUMN "normalizedName" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "gtin" TEXT,
  ADD COLUMN "ean" TEXT,
  ADD COLUMN "upc" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ALTER COLUMN "fingerprint" DROP NOT NULL;
-- Backfill with the same rule as normalizeTitle(): lower-case, alphanumerics
-- and single spaces. Re-normalized by the import service on next update.
UPDATE "Product"
SET "normalizedName" = btrim(regexp_replace(lower("name"), '[^a-z0-9]+', ' ', 'g'));
ALTER TABLE "Product" ALTER COLUMN "normalizedName" SET NOT NULL;

DROP INDEX "Product_categoryId_idx";
CREATE INDEX "Product_categoryId_isActive_idx" ON "Product"("categoryId", "isActive");
CREATE INDEX "Product_normalizedName_trgm_idx" ON "Product" USING GIN ("normalizedName" gin_trgm_ops);
CREATE UNIQUE INDEX "Product_gtin_key" ON "Product"("gtin");
CREATE UNIQUE INDEX "Product_ean_key" ON "Product"("ean");
CREATE UNIQUE INDEX "Product_upc_key" ON "Product"("upc");

-- ── ProductVariant ───────────────────────────────────────────────────────
ALTER TABLE "ProductVariant" ADD COLUMN "sku" TEXT;
CREATE INDEX "ProductVariant_sku_idx" ON "ProductVariant"("sku");
CREATE UNIQUE INDEX "ProductVariant_id_productId_key" ON "ProductVariant"("id", "productId");

-- ── ShoppingSource ───────────────────────────────────────────────────────
ALTER TABLE "ShoppingSource" RENAME COLUMN "code" TO "slug";
ALTER INDEX "ShoppingSource_code_key" RENAME TO "ShoppingSource_slug_key";
ALTER TABLE "ShoppingSource" RENAME CONSTRAINT "ShoppingSource_code_format_check" TO "ShoppingSource_slug_format_check";
ALTER TABLE "ShoppingSource"
  ADD COLUMN "domain" TEXT,
  ADD COLUMN "logoUrl" TEXT,
  ADD COLUMN "status" "SourceStatus" NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN "isSample" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ShoppingSource"
SET "domain" = regexp_replace("baseUrl", '^https?://(www\.)?([^/:]+).*$', '\2'),
    "status" = CASE WHEN "enabled" THEN 'ACTIVE'::"SourceStatus" ELSE 'DISABLED'::"SourceStatus" END;
ALTER TABLE "ShoppingSource" ALTER COLUMN "domain" SET NOT NULL;
ALTER TABLE "ShoppingSource" DROP COLUMN "enabled";
CREATE INDEX "ShoppingSource_status_idx" ON "ShoppingSource"("status");

-- ── ProductOffer ─────────────────────────────────────────────────────────
ALTER TABLE "ProductOffer" RENAME COLUMN "url" TO "productUrl";
ALTER TABLE "ProductOffer" RENAME COLUMN "pricePaise" TO "sellingPricePaise";
ALTER TABLE "ProductOffer" RENAME COLUMN "availability" TO "stockStatus";
ALTER TABLE "ProductOffer" RENAME COLUMN "lastSeenAt" TO "observedAt";
ALTER INDEX "ProductOffer_variantId_pricePaise_idx" RENAME TO "ProductOffer_variantId_sellingPricePaise_idx";
ALTER TABLE "ProductOffer"
  ALTER COLUMN "sellingPricePaise" SET DATA TYPE BIGINT,
  ALTER COLUMN "mrpPaise" SET DATA TYPE BIGINT,
  ADD COLUMN "productId" UUID,
  ADD COLUMN "shippingPaise" BIGINT,
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN "offerConditions" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "matchMethod" "MatchMethod" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "matchConfidence" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN "matchEvidence" JSONB NOT NULL DEFAULT '{}';
UPDATE "ProductOffer" o SET "productId" = v."productId" FROM "ProductVariant" v WHERE v.id = o."variantId";
ALTER TABLE "ProductOffer" ALTER COLUMN "productId" SET NOT NULL;

-- The offer's product must be its variant's product: composite FK.
ALTER TABLE "ProductOffer" DROP CONSTRAINT "ProductOffer_variantId_fkey";
ALTER TABLE "ProductOffer" ADD CONSTRAINT "ProductOffer_variantId_productId_fkey"
  FOREIGN KEY ("variantId", "productId") REFERENCES "ProductVariant"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductOffer" ADD CONSTRAINT "ProductOffer_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ProductOffer_productId_sellingPricePaise_idx" ON "ProductOffer"("productId", "sellingPricePaise");

-- ── PriceSnapshot ────────────────────────────────────────────────────────
ALTER TABLE "PriceSnapshot" RENAME COLUMN "pricePaise" TO "sellingPricePaise";
ALTER TABLE "PriceSnapshot" RENAME COLUMN "availability" TO "stockStatus";
ALTER TABLE "PriceSnapshot" RENAME COLUMN "capturedAt" TO "observedAt";
ALTER INDEX "PriceSnapshot_offerId_capturedAt_idx" RENAME TO "PriceSnapshot_offerId_observedAt_idx";
ALTER TABLE "PriceSnapshot"
  ALTER COLUMN "sellingPricePaise" SET DATA TYPE BIGINT,
  ALTER COLUMN "mrpPaise" SET DATA TYPE BIGINT,
  ADD COLUMN "shippingPaise" BIGINT;

-- ── Other money columns: INT -> BIGINT (in place) ────────────────────────
ALTER TABLE "SearchResult"
  ALTER COLUMN "pricePaiseAtSearch" SET DATA TYPE BIGINT,
  ALTER COLUMN "mrpPaiseAtSearch" SET DATA TYPE BIGINT;
ALTER TABLE "PriceAlert"
  ALTER COLUMN "targetPricePaise" SET DATA TYPE BIGINT,
  ALTER COLUMN "lastTriggeredPricePaise" SET DATA TYPE BIGINT;
ALTER TABLE "SubscriptionPlan" ALTER COLUMN "monthlyPricePaise" SET DATA TYPE BIGINT;
ALTER TABLE "BillingEvent" ALTER COLUMN "amountPaise" SET DATA TYPE BIGINT;

-- ── ProductMatchReview ───────────────────────────────────────────────────
CREATE TABLE "ProductMatchReview" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "listing" JSONB NOT NULL,
    "candidateProductId" UUID,
    "confidence" INTEGER NOT NULL,
    "method" "MatchMethod" NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "status" "MatchReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductMatchReview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductMatchReview_status_createdAt_idx" ON "ProductMatchReview"("status", "createdAt");
CREATE UNIQUE INDEX "ProductMatchReview_sourceId_externalId_key" ON "ProductMatchReview"("sourceId", "externalId");
ALTER TABLE "ProductMatchReview" ADD CONSTRAINT "ProductMatchReview_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "ShoppingSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMatchReview" ADD CONSTRAINT "ProductMatchReview_candidateProductId_fkey"
  FOREIGN KEY ("candidateProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Integrity rules (covered by constraints.db.test.ts) ──────────────────
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_name_not_blank_check" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "Product_gtin_format_check" CHECK ("gtin" IS NULL OR "gtin" ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
  ADD CONSTRAINT "Product_ean_format_check" CHECK ("ean" IS NULL OR "ean" ~ '^[0-9]{8}$|^[0-9]{13}$'),
  ADD CONSTRAINT "Product_upc_format_check" CHECK ("upc" IS NULL OR "upc" ~ '^[0-9]{12}$');
ALTER TABLE "ProductOffer"
  ADD CONSTRAINT "ProductOffer_currency_check" CHECK ("currency" = 'INR'),
  ADD CONSTRAINT "ProductOffer_shipping_check" CHECK ("shippingPaise" IS NULL OR "shippingPaise" >= 0),
  ADD CONSTRAINT "ProductOffer_match_confidence_check" CHECK ("matchConfidence" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "ProductOffer_conditions_object_check" CHECK (jsonb_typeof("offerConditions") = 'object');
ALTER TABLE "PriceSnapshot"
  ADD CONSTRAINT "PriceSnapshot_shipping_check" CHECK ("shippingPaise" IS NULL OR "shippingPaise" >= 0);
ALTER TABLE "ProductMatchReview"
  ADD CONSTRAINT "ProductMatchReview_confidence_check" CHECK ("confidence" BETWEEN 0 AND 10000);
ALTER TABLE "ShoppingSource"
  ADD CONSTRAINT "ShoppingSource_domain_check" CHECK ("domain" ~ '^[a-z0-9.-]+\.[a-z]{2,}$');

-- Price history is append-only: corrections are new rows, never edits.
CREATE FUNCTION dealmind_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a new row instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER "PriceSnapshot_append_only"
  BEFORE UPDATE ON "PriceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION dealmind_reject_update();

-- Specification filters: JSONB containment on variant attributes.
CREATE INDEX "ProductVariant_attributes_gin_idx" ON "ProductVariant" USING GIN ("attributes" jsonb_path_ops);
