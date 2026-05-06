-- Add chat video attachment fields. Videos go to R2 (cheap egress);
-- the client generates the thumbnail (R2 has no auto-thumbnail like
-- Cloudinary) and uploads it alongside the video. Duration is
-- captured client-side too so the bubble can render its time chip
-- without booting a video player.
ALTER TABLE "Message" ADD COLUMN "videoUrl" TEXT;
ALTER TABLE "Message" ADD COLUMN "videoThumbnailUrl" TEXT;
ALTER TABLE "Message" ADD COLUMN "videoDuration" INTEGER;
