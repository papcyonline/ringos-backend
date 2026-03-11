-- CreateEnum
CREATE TYPE "StorySlideType" AS ENUM ('IMAGE', 'VIDEO', 'TEXT');

-- Rename StoryImage table to StorySlide
ALTER TABLE "StoryImage" RENAME TO "StorySlide";

-- Rename imageUrl column to mediaUrl
ALTER TABLE "StorySlide" RENAME COLUMN "imageUrl" TO "mediaUrl";

-- Add new columns with defaults
ALTER TABLE "StorySlide" ADD COLUMN "type" "StorySlideType" NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "StorySlide" ADD COLUMN "thumbnailUrl" TEXT;
ALTER TABLE "StorySlide" ADD COLUMN "duration" INTEGER;

-- Drop old index and foreign key constraint (using old names)
DROP INDEX IF EXISTS "StoryImage_storyId_idx";
ALTER TABLE "StorySlide" DROP CONSTRAINT IF EXISTS "StoryImage_pkey";
ALTER TABLE "StorySlide" DROP CONSTRAINT IF EXISTS "StoryImage_storyId_fkey";

-- Recreate primary key, index, and foreign key with new names
ALTER TABLE "StorySlide" ADD CONSTRAINT "StorySlide_pkey" PRIMARY KEY ("id");
CREATE INDEX "StorySlide_storyId_idx" ON "StorySlide"("storyId");
ALTER TABLE "StorySlide" ADD CONSTRAINT "StorySlide_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
