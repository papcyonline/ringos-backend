-- Add STORY_MILESTONE to NotificationType for the new tiered
-- view/like notifications ("Your story reached 100 views", etc.).
-- Non-breaking: only adds a new enum value.

ALTER TYPE "NotificationType" ADD VALUE 'STORY_MILESTONE';
