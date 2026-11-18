-- Prompt 25 Stage 4: first-time onboarding state (additive, nullable/defaulted: backward compatible).
ALTER TABLE "User" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "onboardingSkipped" BOOLEAN NOT NULL DEFAULT false;
