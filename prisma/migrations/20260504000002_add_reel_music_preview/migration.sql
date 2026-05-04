-- Reel music attachment columns. All nullable so existing reels (which
-- have musicTitle but no preview URL / artist / artwork) keep working.
-- The viewer plays musicPreviewUrl through an AudioPlayer when set;
-- when null, falls back to the original video audio.
ALTER TABLE "Reel" ADD COLUMN "musicPreviewUrl" TEXT;
ALTER TABLE "Reel" ADD COLUMN "musicArtist"     TEXT;
ALTER TABLE "Reel" ADD COLUMN "musicArtwork"    TEXT;
