-- Guest search (no account): additive, defaulted; existing users are not guests.
ALTER TABLE "User" ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "User_isGuest_createdAt_idx" ON "User"("isGuest", "createdAt");