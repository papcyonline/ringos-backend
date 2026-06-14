-- Add a profile cover/banner image to User, separate from the avatar.
-- Nullable so existing rows are unaffected (they render a fallback banner).
ALTER TABLE "User" ADD COLUMN "coverUrl" TEXT;
