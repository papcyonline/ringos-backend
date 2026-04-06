-- Add new notification types
ALTER TYPE "NotificationType" ADD VALUE 'POST_LIKED';
ALTER TYPE "NotificationType" ADD VALUE 'POST_COMMENTED';

-- Create PostMedia table
CREATE TABLE "PostMedia" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "cloudinaryId" TEXT NOT NULL DEFAULT '',
    "thumbnailUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "PostMedia_postId_position_idx" ON "PostMedia"("postId", "position");

-- Add foreign key
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing single-media posts to PostMedia
INSERT INTO "PostMedia" ("id", "postId", "type", "url", "thumbnailUrl", "position")
SELECT gen_random_uuid(), "id",
  CASE WHEN "mediaType" = 'video' THEN 'VIDEO' ELSE 'IMAGE' END,
  "mediaUrl", "thumbnailUrl", 0
FROM "Post" WHERE "mediaUrl" IS NOT NULL;
