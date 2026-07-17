-- Pin reels to the top of the author's profile grid. Nullable timestamp
-- (most-recently-pinned first); null = not pinned. Additive + safe.
ALTER TABLE "Reel" ADD COLUMN "pinnedAt" TIMESTAMP(3);
