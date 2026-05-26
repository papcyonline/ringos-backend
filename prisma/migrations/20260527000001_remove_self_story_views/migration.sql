-- Remove "self-views": rows where the viewer is the story's own owner. The
-- old mark-viewed path recorded these (and the slide-view backfill copied
-- them), so an owner could appear in their own story's view count / viewer
-- list. Self-exclusion is now enforced in markStoryViewed / markStorySlideViewed;
-- this cleans up the historical rows.

DELETE FROM "StoryView" v
USING "Story" s
WHERE v."storyId" = s."id"
  AND v."viewerId" = s."userId";

DELETE FROM "StorySlideView" sv
USING "StorySlide" sl, "Story" s
WHERE sv."slideId" = sl."id"
  AND sl."storyId" = s."id"
  AND sv."viewerId" = s."userId";
