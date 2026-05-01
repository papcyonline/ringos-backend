-- AlterTable
ALTER TABLE "Reel" ADD COLUMN "repostCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ReelRepost" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelRepost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReelRepost_reelId_userId_key" ON "ReelRepost"("reelId", "userId");

-- CreateIndex
CREATE INDEX "ReelRepost_userId_createdAt_idx" ON "ReelRepost"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReelRepost_reelId_idx" ON "ReelRepost"("reelId");

-- AddForeignKey
ALTER TABLE "ReelRepost" ADD CONSTRAINT "ReelRepost_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelRepost" ADD CONSTRAINT "ReelRepost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
