-- Phase A: per-story visibility flag + story-mute table.
-- Additive only. Existing stories default to FRIENDS (no backfill needed).

-- CreateEnum
CREATE TYPE "StoryVisibility" AS ENUM ('FRIENDS', 'PUBLIC');

-- AlterTable
ALTER TABLE "Story" ADD COLUMN "visibility" "StoryVisibility" NOT NULL DEFAULT 'FRIENDS';

-- CreateIndex
CREATE INDEX "Story_visibility_expiresAt_idx" ON "Story"("visibility", "expiresAt");

-- CreateTable
CREATE TABLE "StoryMute" (
    "id" TEXT NOT NULL,
    "muterId" TEXT NOT NULL,
    "mutedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryMute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryMute_muterId_mutedUserId_key" ON "StoryMute"("muterId", "mutedUserId");

-- CreateIndex
CREATE INDEX "StoryMute_muterId_idx" ON "StoryMute"("muterId");

-- CreateIndex
CREATE INDEX "StoryMute_mutedUserId_idx" ON "StoryMute"("mutedUserId");

-- AddForeignKey
ALTER TABLE "StoryMute" ADD CONSTRAINT "StoryMute_muterId_fkey" FOREIGN KEY ("muterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryMute" ADD CONSTRAINT "StoryMute_mutedUserId_fkey" FOREIGN KEY ("mutedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
