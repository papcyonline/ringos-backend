-- Stage 1: additive only. No drops; old app builds keep working.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StoryReaction" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryReaction_storyId_userId_key" ON "StoryReaction"("storyId", "userId");

-- CreateIndex
CREATE INDEX "StoryReaction_storyId_idx" ON "StoryReaction"("storyId");

-- CreateIndex
CREATE INDEX "StoryReaction_userId_idx" ON "StoryReaction"("userId");

-- AddForeignKey
ALTER TABLE "StoryReaction" ADD CONSTRAINT "StoryReaction_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryReaction" ADD CONSTRAINT "StoryReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: soft-archive every existing channel conversation
UPDATE "Conversation" SET "archivedAt" = NOW() WHERE "isChannel" = true AND "archivedAt" IS NULL;

-- Backfill: convert existing StoryView.liked=true rows into ❤️ reactions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO "StoryReaction" ("id", "storyId", "userId", "emoji", "createdAt")
SELECT gen_random_uuid(), "storyId", "viewerId", '❤️', "createdAt"
FROM "StoryView"
WHERE "liked" = true
ON CONFLICT ("storyId", "userId") DO NOTHING;
