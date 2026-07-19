-- Adaptive HLS for reels (self-hosted on R2). Additive, nullable columns so
-- existing reels keep working via the MP4 videoUrl; hlsUrl/hlsKey are populated
-- only for new reels. hlsKey is the R2 directory prefix for cleanup.
ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "hlsUrl" TEXT;
ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "hlsKey" TEXT;
