-- StorySlideView: per-slide view tracking (Instagram-style). One row per
-- viewer per slide so each slide carries its own view count + viewer list.
-- StoryView (story-level) is left intact and keeps powering the unviewed
-- ring, the "viewed your story" notification, and view milestones.

CREATE TABLE "StorySlideView" (
    "id" TEXT NOT NULL,
    "slideId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "isStealth" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorySlideView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorySlideView_slideId_viewerId_key" ON "StorySlideView"("slideId", "viewerId");

-- CreateIndex
CREATE INDEX "StorySlideView_slideId_idx" ON "StorySlideView"("slideId");

-- CreateIndex
CREATE INDEX "StorySlideView_viewerId_idx" ON "StorySlideView"("viewerId");

-- AddForeignKey
ALTER TABLE "StorySlideView" ADD CONSTRAINT "StorySlideView_slideId_fkey" FOREIGN KEY ("slideId") REFERENCES "StorySlide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorySlideView" ADD CONSTRAINT "StorySlideView_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: attribute every existing story-level view to that story's first
-- slide (lowest position = the entry frame every viewer saw). Later slides
-- start at zero, which is correct — we don't know who actually advanced.
INSERT INTO "StorySlideView" ("id", "slideId", "viewerId", "isStealth", "createdAt")
SELECT gen_random_uuid(), s."id", v."viewerId", v."isStealth", v."createdAt"
FROM "StoryView" v
JOIN LATERAL (
    SELECT sl."id"
    FROM "StorySlide" sl
    WHERE sl."storyId" = v."storyId"
    ORDER BY sl."position" ASC, sl."createdAt" ASC
    LIMIT 1
) s ON true
ON CONFLICT ("slideId", "viewerId") DO NOTHING;
