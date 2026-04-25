-- Add iTunes 30-sec preview URL + artwork URL alongside the existing
-- musicTitle / musicArtist columns so post viewers can play the clip.
ALTER TABLE "Post" ADD COLUMN "musicPreviewUrl" TEXT;
ALTER TABLE "Post" ADD COLUMN "musicArtwork" TEXT;
