-- Content-level reporting: pinpoint the specific story/reel/post/message/comment
-- being reported, in addition to the reported user (Apple App Store Guideline 1.2).
-- Additive + nullable — existing user-level reports keep working unchanged.
CREATE TYPE "ReportContentType" AS ENUM ('STORY', 'REEL', 'POST', 'MESSAGE', 'COMMENT');

ALTER TABLE "Report" ADD COLUMN "contentType" "ReportContentType";
ALTER TABLE "Report" ADD COLUMN "contentId" TEXT;
