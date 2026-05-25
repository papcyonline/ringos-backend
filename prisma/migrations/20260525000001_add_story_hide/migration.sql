-- StoryHide: a story owner hides their stories from a specific viewer.
-- Inverse direction of StoryMute (which is the viewer muting an owner).
-- The owner's stories are excluded from the hidden viewer's feeds.

CREATE TABLE "StoryHide" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "hiddenUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryHide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryHide_ownerId_hiddenUserId_key" ON "StoryHide"("ownerId", "hiddenUserId");

-- CreateIndex
CREATE INDEX "StoryHide_ownerId_idx" ON "StoryHide"("ownerId");

-- CreateIndex
CREATE INDEX "StoryHide_hiddenUserId_idx" ON "StoryHide"("hiddenUserId");

-- AddForeignKey
ALTER TABLE "StoryHide" ADD CONSTRAINT "StoryHide_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryHide" ADD CONSTRAINT "StoryHide_hiddenUserId_fkey" FOREIGN KEY ("hiddenUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
