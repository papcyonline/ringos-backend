-- Story engagement counters used by the viewer's right-side action rail.
-- All fields default to 0 so existing rows are valid. A best-effort
-- backfill of likeCount + commentCount runs after the column adds; the
-- other three start at 0 since they were never tracked before.

ALTER TABLE "Story" ADD COLUMN "likeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Story" ADD COLUMN "commentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Story" ADD COLUMN "repostCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Story" ADD COLUMN "shareCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Story" ADD COLUMN "downloadCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill likeCount from StoryReaction so the displayed totals don't
-- start at zero on stories that already have likes.
UPDATE "Story" s
SET "likeCount" = (
  SELECT COUNT(*) FROM "StoryReaction" r
  WHERE r."storyId" = s.id AND r.emoji = '❤️'
);

-- Backfill commentCount by counting messages whose metadata references
-- this story via storyContext. JSONB extraction is fine here — this
-- runs once at deploy time on a small table.
UPDATE "Story" s
SET "commentCount" = (
  SELECT COUNT(*) FROM "Message" m
  WHERE m."deletedAt" IS NULL
    AND m.metadata ->'storyContext'->>'storyId' = s.id
);
