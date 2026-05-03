-- CreateTable
CREATE TABLE "MessageStreak" (
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastMutualDay" TIMESTAMP(3),
    "lastUserAMessageDay" TIMESTAMP(3),
    "lastUserBMessageDay" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageStreak_pkey" PRIMARY KEY ("userAId", "userBId")
);

-- CreateIndex
CREATE INDEX "MessageStreak_userAId_idx" ON "MessageStreak"("userAId");

-- CreateIndex
CREATE INDEX "MessageStreak_userBId_idx" ON "MessageStreak"("userBId");

-- AddForeignKey
ALTER TABLE "MessageStreak" ADD CONSTRAINT "MessageStreak_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageStreak" ADD CONSTRAINT "MessageStreak_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
