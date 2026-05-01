-- CreateTable
CREATE TABLE "Reel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "cloudinaryId" TEXT,
    "thumbnailUrl" TEXT,
    "caption" TEXT,
    "musicTitle" TEXT,
    "durationSec" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReelLike" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reel_userId_createdAt_idx" ON "Reel"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Reel_createdAt_idx" ON "Reel"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReelLike_reelId_userId_key" ON "ReelLike"("reelId", "userId");

-- CreateIndex
CREATE INDEX "ReelLike_reelId_idx" ON "ReelLike"("reelId");

-- CreateIndex
CREATE INDEX "ReelLike_userId_idx" ON "ReelLike"("userId");

-- AddForeignKey
ALTER TABLE "Reel" ADD CONSTRAINT "Reel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelLike" ADD CONSTRAINT "ReelLike_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelLike" ADD CONSTRAINT "ReelLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
