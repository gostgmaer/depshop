-- First-run admin setup (single row). Additive.
CREATE TABLE "PlatformSetup" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "setupTokenHash" TEXT,
    "adminEmail" TEXT,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformSetup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformSetup_single_row" CHECK ("id" = 1)
);
