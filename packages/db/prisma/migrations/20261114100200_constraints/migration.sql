-- Database-level invariants that Prisma's schema language cannot express.
-- Every constraint here is covered by packages/db/test/*.db.test.ts.
-- Naming: <Table>_<rule>_check.

-- ── Identity ──────────────────────────────────────────────────────────────
-- Emails are stored normalised so the unique index is case-insensitive.
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_lowercase_check" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "User_email_format_check" CHECK ("email" ~ '^[^@\s]+@[^@\s]+$'),
  ADD CONSTRAINT "User_name_not_blank_check" CHECK (length(btrim("name")) > 0);

ALTER TABLE "UserSession"
  ADD CONSTRAINT "UserSession_expiry_check" CHECK ("expiresAt" > "createdAt");

-- ── Catalog ───────────────────────────────────────────────────────────────
ALTER TABLE "Category"
  ADD CONSTRAINT "Category_not_own_parent_check" CHECK ("parentId" IS NULL OR "parentId" <> "id");

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_specs_object_check" CHECK (jsonb_typeof("specs") = 'object');

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "ProductVariant_attributes_object_check" CHECK (jsonb_typeof("attributes") = 'object');

-- ── Shopping: money is non-negative integer paise ─────────────────────────
ALTER TABLE "ShoppingSource"
  ADD CONSTRAINT "ShoppingSource_timeout_check" CHECK ("timeoutMs" BETWEEN 100 AND 120000),
  ADD CONSTRAINT "ShoppingSource_rate_limit_check" CHECK ("rateLimitPerMinute" > 0),
  ADD CONSTRAINT "ShoppingSource_retries_check" CHECK ("maxRetries" BETWEEN 0 AND 10),
  ADD CONSTRAINT "ShoppingSource_code_format_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*$');

ALTER TABLE "ProductOffer"
  ADD CONSTRAINT "ProductOffer_price_check" CHECK ("pricePaise" >= 0),
  ADD CONSTRAINT "ProductOffer_mrp_check" CHECK ("mrpPaise" IS NULL OR "mrpPaise" >= 0),
  ADD CONSTRAINT "ProductOffer_url_check" CHECK ("url" ~ '^https?://');

ALTER TABLE "PriceSnapshot"
  ADD CONSTRAINT "PriceSnapshot_price_check" CHECK ("pricePaise" >= 0),
  ADD CONSTRAINT "PriceSnapshot_mrp_check" CHECK ("mrpPaise" IS NULL OR "mrpPaise" >= 0);

-- ── Search ────────────────────────────────────────────────────────────────
ALTER TABLE "SearchSourceRun"
  ADD CONSTRAINT "SearchSourceRun_duration_check" CHECK ("durationMs" >= 0),
  ADD CONSTRAINT "SearchSourceRun_result_count_check" CHECK ("resultCount" >= 0);

ALTER TABLE "SearchResult"
  ADD CONSTRAINT "SearchResult_rank_check" CHECK ("rank" >= 1),
  ADD CONSTRAINT "SearchResult_price_check" CHECK ("pricePaiseAtSearch" >= 0),
  ADD CONSTRAINT "SearchResult_mrp_check" CHECK ("mrpPaiseAtSearch" IS NULL OR "mrpPaiseAtSearch" >= 0);

-- ── User features ─────────────────────────────────────────────────────────
ALTER TABLE "Watchlist"
  ADD CONSTRAINT "Watchlist_name_not_blank_check" CHECK (length(btrim("name")) > 0);

ALTER TABLE "PriceAlert"
  ADD CONSTRAINT "PriceAlert_target_check" CHECK ("targetPricePaise" > 0),
  ADD CONSTRAINT "PriceAlert_last_price_check" CHECK ("lastTriggeredPricePaise" IS NULL OR "lastTriggeredPricePaise" >= 0);

-- One alert per (user, variant, source), where a NULL source ("any source")
-- also counts as a single value. Prisma creates this unique index with the
-- default NULLS DISTINCT semantics; recreate it with NULLS NOT DISTINCT (PG 15+).
DROP INDEX "PriceAlert_userId_variantId_sourceId_key";
CREATE UNIQUE INDEX "PriceAlert_userId_variantId_sourceId_key"
  ON "PriceAlert" ("userId", "variantId", "sourceId") NULLS NOT DISTINCT;

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "NotificationDelivery_sent_at_check" CHECK ("status" <> 'SENT' OR "sentAt" IS NOT NULL);

-- ── AI ────────────────────────────────────────────────────────────────────
ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_tokens_check" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0),
  ADD CONSTRAINT "AgentRun_finished_check" CHECK ("status" = 'RUNNING' OR "finishedAt" IS NOT NULL);

ALTER TABLE "AiModelConfig"
  ADD CONSTRAINT "AiModelConfig_temperature_check" CHECK ("temperature" >= 0 AND "temperature" <= 2),
  ADD CONSTRAINT "AiModelConfig_max_tokens_check" CHECK ("maxTokens" > 0);

-- ── Monetization ──────────────────────────────────────────────────────────
ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT "SubscriptionPlan_price_check" CHECK ("monthlyPricePaise" >= 0),
  ADD CONSTRAINT "SubscriptionPlan_limits_object_check" CHECK (jsonb_typeof("limits") = 'object');

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_period_check" CHECK ("currentPeriodEnd" IS NULL OR "currentPeriodEnd" > "currentPeriodStart");

ALTER TABLE "UsageRecord"
  ADD CONSTRAINT "UsageRecord_quantity_check" CHECK ("quantity" > 0);

ALTER TABLE "AffiliateConversion"
  ADD CONSTRAINT "AffiliateConversion_amounts_check" CHECK ("orderAmountPaise" >= 0 AND "commissionPaise" >= 0);

-- Refunds are recorded as a positive amount with type REFUND_ISSUED.
ALTER TABLE "BillingEvent"
  ADD CONSTRAINT "BillingEvent_amount_check" CHECK ("amountPaise" IS NULL OR "amountPaise" >= 0);
