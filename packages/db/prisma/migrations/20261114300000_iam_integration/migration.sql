-- Identity moves to the shared EasyDev IAM (see docs/AUTH.md).
--
-- 1. Local accounts created before the IAM integration have no IAM identity
--    and cannot be linked automatically (DealMind never had IAM user ids).
--    Refuse to continue rather than drop or guess: link or remove them first.
--    This check runs FIRST, so a refusal changes nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User") THEN
    RAISE EXCEPTION 'Pre-IAM DealMind users exist. Link them to IAM identities (set "iamUserId") or remove them before applying 20261114300000_iam_integration.';
  END IF;
END
$$;

-- 2. Sessions created before this migration hold no IAM tokens and cannot be
--    used any more: delete them (every user simply signs in again).
DELETE FROM "UserSession";


-- DropForeignKey
ALTER TABLE "AuthToken" DROP CONSTRAINT "AuthToken_userId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "passwordHash",
ADD COLUMN     "iamUserId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "UserSession" ADD COLUMN     "iamAccessTokenEnc" TEXT NOT NULL,
ADD COLUMN     "iamAccessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "iamRefreshTokenEnc" TEXT NOT NULL,
ADD COLUMN     "iamRefreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "iamSessionId" UUID;

-- DropTable
DROP TABLE "AuthToken";

-- DropEnum
DROP TYPE "AuthTokenType";

-- CreateIndex
CREATE UNIQUE INDEX "User_iamUserId_key" ON "User"("iamUserId");

-- CreateIndex
CREATE INDEX "UserSession_iamSessionId_idx" ON "UserSession"("iamSessionId");

