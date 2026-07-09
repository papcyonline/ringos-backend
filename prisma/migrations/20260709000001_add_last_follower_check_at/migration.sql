-- Tracks when the user last opened their own followers list, so the
-- "new followers" push digest only counts followers gained since then.
-- Additive + nullable (NULL = never checked).
ALTER TABLE "User" ADD COLUMN "lastFollowerCheckAt" TIMESTAMP(3);
