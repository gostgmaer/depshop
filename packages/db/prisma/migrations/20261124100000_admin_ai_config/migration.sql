-- Phase 6.3: admin-managed LLM settings read by the agent at run time.
-- No API keys are stored: providers are named only; keys stay in the agent's environment.
ALTER TABLE "AiModelConfig"
  ADD COLUMN "fallbackModel" TEXT,
  ADD COLUMN "fallbackProvider" TEXT,
  ADD COLUMN "inputPaisePerMillionTokens" BIGINT,
  ADD COLUMN "monthlyTokenLimit" INTEGER,
  ADD COLUMN "outputPaisePerMillionTokens" BIGINT,
  ADD COLUMN "updatedById" UUID;

ALTER TABLE "AiModelConfig"
  ADD CONSTRAINT "AiModelConfig_provider_check" CHECK ("provider" IN ('google', 'openai', 'rules')),
  ADD CONSTRAINT "AiModelConfig_fallback_check" CHECK (
    ("fallbackProvider" IS NULL AND "fallbackModel" IS NULL)
    OR ("fallbackProvider" IN ('google', 'openai', 'rules') AND "fallbackModel" IS NOT NULL)),
  ADD CONSTRAINT "AiModelConfig_model_check" CHECK ("provider" = 'rules' OR length("model") BETWEEN 1 AND 100),
  DROP CONSTRAINT "AiModelConfig_max_tokens_check",
  ADD CONSTRAINT "AiModelConfig_max_tokens_check" CHECK ("maxTokens" BETWEEN 256 AND 200000),
  ADD CONSTRAINT "AiModelConfig_limits_check" CHECK (
    ("monthlyTokenLimit" IS NULL OR "monthlyTokenLimit" > 0)
    AND ("inputPaisePerMillionTokens" IS NULL OR "inputPaisePerMillionTokens" >= 0)
    AND ("outputPaisePerMillionTokens" IS NULL OR "outputPaisePerMillionTokens" >= 0));
