-- Phase 3.1: LangGraph shopping agent.
ALTER TYPE "SearchStatus" ADD VALUE IF NOT EXISTS 'NEEDS_CLARIFICATION';
ALTER TYPE "SearchStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "AgentRunStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "AgentRun"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "threadId" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX "AgentRun_threadId_key" ON "AgentRun"("threadId");

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "AgentRun_duration_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
  ADD CONSTRAINT "AgentRun_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object');
