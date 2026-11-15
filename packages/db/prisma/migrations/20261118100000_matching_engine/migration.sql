-- Phase 3.2: product matching & deduplication engine.

-- New evidence kinds.
ALTER TYPE "MatchMethod" ADD VALUE IF NOT EXISTS 'MPN' AFTER 'IDENTIFIER';
ALTER TYPE "MatchMethod" ADD VALUE IF NOT EXISTS 'SEMANTIC' AFTER 'FUZZY_TITLE';

-- Identifiers / duplicate-offer detection.
ALTER TABLE "ProductVariant" ADD COLUMN "mpn" TEXT;
CREATE INDEX "ProductVariant_mpn_idx" ON "ProductVariant"("mpn");
ALTER TABLE "ProductOffer" ADD COLUMN "canonicalUrl" TEXT;
CREATE INDEX "ProductOffer_sourceId_canonicalUrl_idx" ON "ProductOffer"("sourceId", "canonicalUrl");

-- Review workflow fields.
ALTER TABLE "ProductMatchReview"
  ADD COLUMN "auditId" UUID,
  ADD COLUMN "reviewedBy" UUID,
  ADD COLUMN "reviewNote" TEXT;

-- Audit.
CREATE TYPE "MatchConfidence" AS ENUM ('VERY_HIGH', 'HIGH', 'REVIEW', 'LOW');
CREATE TYPE "MatchDecisionKind" AS ENUM ('AUTO_MERGE', 'NEW_PRODUCT', 'MANUAL_REVIEW', 'NO_MATCH', 'DUPLICATE_OFFER', 'REVIEW_RESOLVED');
CREATE TYPE "MatchSubjectKind" AS ENUM ('LISTING', 'PRODUCT_PAIR');
CREATE TYPE "MatchOrigin" AS ENUM ('IMPORT', 'INTERNAL_API', 'DUPLICATE_SCAN', 'REVIEW');

CREATE TABLE "ProductMatchAudit" (
    "id" UUID NOT NULL,
    "subject" "MatchSubjectKind" NOT NULL,
    "origin" "MatchOrigin" NOT NULL,
    "sourceId" UUID,
    "externalId" TEXT,
    "listing" JSONB,
    "productAId" UUID,
    "candidateProductId" UUID,
    "candidateVariantId" UUID,
    "resultProductId" UUID,
    "resultVariantId" UUID,
    "scoreBp" INTEGER NOT NULL,
    "confidence" "MatchConfidence" NOT NULL,
    "decision" "MatchDecisionKind" NOT NULL,
    "method" "MatchMethod" NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "engineVersion" TEXT NOT NULL,
    "reviewOfId" UUID,
    "reviewer" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductMatchAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductMatchAudit_sourceId_externalId_idx" ON "ProductMatchAudit"("sourceId", "externalId");
CREATE INDEX "ProductMatchAudit_candidateProductId_idx" ON "ProductMatchAudit"("candidateProductId");
CREATE INDEX "ProductMatchAudit_productAId_idx" ON "ProductMatchAudit"("productAId");
CREATE INDEX "ProductMatchAudit_decision_createdAt_idx" ON "ProductMatchAudit"("decision", "createdAt");
CREATE INDEX "ProductMatchAudit_reviewOfId_idx" ON "ProductMatchAudit"("reviewOfId");
ALTER TABLE "ProductMatchAudit" ADD CONSTRAINT "ProductMatchAudit_reviewOfId_fkey"
  FOREIGN KEY ("reviewOfId") REFERENCES "ProductMatchAudit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMatchAudit"
  ADD CONSTRAINT "ProductMatchAudit_score_check" CHECK ("scoreBp" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "ProductMatchAudit_evidence_object_check" CHECK (jsonb_typeof("evidence") = 'object'),
  ADD CONSTRAINT "ProductMatchAudit_conflicts_array_check" CHECK (jsonb_typeof("conflicts") = 'array'),
  ADD CONSTRAINT "ProductMatchAudit_review_check" CHECK (("decision" = 'REVIEW_RESOLVED') = ("reviewOfId" IS NOT NULL AND "reviewer" IS NOT NULL));
-- Audit rows are history: never edited.
CREATE TRIGGER "ProductMatchAudit_append_only"
  BEFORE UPDATE ON "ProductMatchAudit"
  FOR EACH ROW EXECUTE FUNCTION dealmind_reject_update();

-- Optional semantic fallback: embeddings live in their own schema (not Prisma-managed),
-- only when pgvector is installed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE SCHEMA IF NOT EXISTS matching;
    -- New in this migration; recreate so a half-dropped leftover can never survive.
    DROP TABLE IF EXISTS matching.product_embeddings;
    CREATE TABLE matching.product_embeddings (
      product_id UUID PRIMARY KEY REFERENCES public."Product"(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      embedding vector(256) NOT NULL,
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX product_embeddings_hnsw_idx
      ON matching.product_embeddings USING hnsw (embedding vector_cosine_ops);
  END IF;
END
$$;
