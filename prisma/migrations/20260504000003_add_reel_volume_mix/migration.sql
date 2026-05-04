-- Mix levels (0..1) the creator picks in the editor. Null = legacy
-- default behaviour: video volume 0, music volume 1 ("music replaces
-- original audio"). Both columns are nullable so existing reels keep
-- working.
ALTER TABLE "Reel" ADD COLUMN "videoVolume" DOUBLE PRECISION;
ALTER TABLE "Reel" ADD COLUMN "musicVolume" DOUBLE PRECISION;
