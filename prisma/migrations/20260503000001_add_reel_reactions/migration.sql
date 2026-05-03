-- CreateTable
CREATE TABLE "ReelReaction" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReelReaction_reelId_userId_key" ON "ReelReaction"("reelId", "userId");

-- CreateIndex
CREATE INDEX "ReelReaction_reelId_idx" ON "ReelReaction"("reelId");

-- CreateIndex
CREATE INDEX "ReelReaction_userId_idx" ON "ReelReaction"("userId");

-- AddForeignKey
ALTER TABLE "ReelReaction" ADD CONSTRAINT "ReelReaction_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "Reel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelReaction" ADD CONSTRAINT "ReelReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
