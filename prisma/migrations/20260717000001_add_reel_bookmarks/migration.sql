-- Reel bookmarks (save). Personal save per user, with a denormalized count on
-- Reel (mirrors likeCount/repostCount). Additive.
ALTER TABLE "Reel" ADD COLUMN "bookmarkCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ReelBookmark" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReelBookmark_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReelBookmark_reelId_userId_key" ON "ReelBookmark"("reelId", "userId");
CREATE INDEX "ReelBookmark_reelId_idx" ON "ReelBookmark"("reelId");
CREATE INDEX "ReelBookmark_userId_createdAt_idx" ON "ReelBookmark"("userId", "createdAt");
ALTER TABLE "ReelBookmark" ADD CONSTRAINT "ReelBookmark_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReelBookmark" ADD CONSTRAINT "ReelBookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
