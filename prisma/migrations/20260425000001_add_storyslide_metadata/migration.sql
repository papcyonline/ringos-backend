-- Adds an optional JSON metadata column to StorySlide. Used to attach
-- supplemental info to a slide (e.g. music: {previewUrl, title, artist,
-- artwork}) without further schema changes.
ALTER TABLE "StorySlide" ADD COLUMN "metadata" JSONB;
