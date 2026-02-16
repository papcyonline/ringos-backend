-- CreateTable
CREATE TABLE "SpotlightLog" (
    "id" TEXT NOT NULL,
    "broadcasterId" TEXT NOT NULL,
    "note" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "totalViewers" INTEGER NOT NULL DEFAULT 0,
    "connectCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SpotlightLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpotlightLog_broadcasterId_idx" ON "SpotlightLog"("broadcasterId");

-- CreateIndex
CREATE INDEX "SpotlightLog_startedAt_idx" ON "SpotlightLog"("startedAt");

-- AddForeignKey
ALTER TABLE "SpotlightLog" ADD CONSTRAINT "SpotlightLog_broadcasterId_fkey" FOREIGN KEY ("broadcasterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
