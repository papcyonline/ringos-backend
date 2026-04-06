-- Add post metadata fields
ALTER TABLE "Post" ADD COLUMN "locationName" TEXT;
ALTER TABLE "Post" ADD COLUMN "taggedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Post" ADD COLUMN "musicTitle" TEXT;
ALTER TABLE "Post" ADD COLUMN "musicArtist" TEXT;
ALTER TABLE "Post" ADD COLUMN "commentsDisabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Post" ADD COLUMN "hideLikeCount" BOOLEAN NOT NULL DEFAULT false;
