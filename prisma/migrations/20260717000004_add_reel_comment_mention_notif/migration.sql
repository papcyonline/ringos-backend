-- New notification type for @mentions in reel comments. Additive enum value.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REEL_COMMENT_MENTION';
