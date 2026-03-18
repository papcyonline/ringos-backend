-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'GOOGLE', 'APPLE', 'PHONE', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CHAT_MESSAGE', 'VOICE_NOTE', 'NEW_FOLLOWER', 'PROFILE_LIKED', 'MATCH_FOUND', 'STORY_GIFT', 'STORY_LIKED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PURCHASE', 'GIFT', 'TIP');

-- CreateTable: UserModeration (extract ban/flag fields from User)
CREATE TABLE "UserModeration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "banStatus" "BanStatus" NOT NULL DEFAULT 'NONE',
    "banExpiresAt" TIMESTAMP(3),
    "flagCount" INTEGER NOT NULL DEFAULT 0,
    "lastFlaggedAt" TIMESTAMP(3),
    CONSTRAINT "UserModeration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserModeration_userId_key" ON "UserModeration"("userId");
CREATE INDEX "UserModeration_banStatus_idx" ON "UserModeration"("banStatus");
ALTER TABLE "UserModeration" ADD CONSTRAINT "UserModeration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing ban data from User to UserModeration
INSERT INTO "UserModeration" ("id", "userId", "banStatus", "banExpiresAt", "flagCount", "lastFlaggedAt")
SELECT gen_random_uuid(), "id", "banStatus", "banExpiresAt", "flagCount", "lastFlaggedAt"
FROM "User"
WHERE "banStatus" != 'NONE' OR "flagCount" > 0;

-- CreateTable: Subscription (extract subscription fields from User)
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalId" TEXT,
    "status" TEXT,
    "plan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing subscription data from User to Subscription
INSERT INTO "Subscription" ("id", "userId", "externalId", "status", "plan", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", "subscriptionId", "subscriptionStatus", "subscriptionPlan", "createdAt", "updatedAt"
FROM "User"
WHERE "subscriptionId" IS NOT NULL;

-- Convert User.authProvider from String to AuthProvider enum
ALTER TABLE "User" ALTER COLUMN "authProvider" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "authProvider" TYPE "AuthProvider" USING (
  CASE "authProvider"
    WHEN 'email' THEN 'EMAIL'::"AuthProvider"
    WHEN 'google' THEN 'GOOGLE'::"AuthProvider"
    WHEN 'apple' THEN 'APPLE'::"AuthProvider"
    WHEN 'phone' THEN 'PHONE'::"AuthProvider"
    WHEN 'anonymous' THEN 'ANONYMOUS'::"AuthProvider"
    ELSE 'EMAIL'::"AuthProvider"
  END
);
ALTER TABLE "User" ALTER COLUMN "authProvider" SET DEFAULT 'EMAIL'::"AuthProvider";

-- Convert User.gender from String to Gender enum
ALTER TABLE "User" ALTER COLUMN "gender" TYPE "Gender" USING (
  CASE LOWER("gender")
    WHEN 'male' THEN 'MALE'::"Gender"
    WHEN 'female' THEN 'FEMALE'::"Gender"
    WHEN 'other' THEN 'OTHER'::"Gender"
    ELSE NULL
  END
);

-- Convert Notification.type from String to NotificationType enum
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType" USING (
  CASE "type"
    WHEN 'chat_message' THEN 'CHAT_MESSAGE'::"NotificationType"
    WHEN 'voice_note' THEN 'VOICE_NOTE'::"NotificationType"
    WHEN 'new_follower' THEN 'NEW_FOLLOWER'::"NotificationType"
    WHEN 'profile_liked' THEN 'PROFILE_LIKED'::"NotificationType"
    WHEN 'match_found' THEN 'MATCH_FOUND'::"NotificationType"
    WHEN 'story_gift' THEN 'STORY_GIFT'::"NotificationType"
    WHEN 'story_liked' THEN 'STORY_LIKED'::"NotificationType"
    ELSE 'SYSTEM'::"NotificationType"
  END
);

-- Convert CoinTransaction.type from String to TransactionType enum
ALTER TABLE "CoinTransaction" ALTER COLUMN "type" TYPE "TransactionType" USING (
  CASE "type"
    WHEN 'purchase' THEN 'PURCHASE'::"TransactionType"
    WHEN 'gift' THEN 'GIFT'::"TransactionType"
    WHEN 'tip' THEN 'TIP'::"TransactionType"
    ELSE 'PURCHASE'::"TransactionType"
  END
);

-- Drop old columns from User (after data migration)
ALTER TABLE "User" DROP COLUMN "banStatus";
ALTER TABLE "User" DROP COLUMN "banExpiresAt";
ALTER TABLE "User" DROP COLUMN "flagCount";
ALTER TABLE "User" DROP COLUMN "lastFlaggedAt";
ALTER TABLE "User" DROP COLUMN "subscriptionId";
ALTER TABLE "User" DROP COLUMN "subscriptionStatus";
ALTER TABLE "User" DROP COLUMN "subscriptionPlan";

-- Drop old index that referenced User.banStatus
DROP INDEX IF EXISTS "User_banStatus_idx";
