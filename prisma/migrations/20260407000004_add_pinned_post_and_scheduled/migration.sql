-- Add pinned post
ALTER TABLE "Conversation" ADD COLUMN "pinnedPostId" TEXT;

-- Add scheduled publish date to posts
ALTER TABLE "Post" ADD COLUMN "scheduledAt" TIMESTAMP(3);
ALTER TABLE "Post" ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT true;

-- Add view tracking
ALTER TABLE "Post" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
