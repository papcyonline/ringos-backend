-- Engagement digest notifications:
--   MESSAGE_REQUESTS_DIGEST — periodic "you have N pending requests"
--   NEW_FOLLOWERS_DIGEST    — periodic "N new followers since you were away"
-- Non-breaking: only adds new enum values.

ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_REQUESTS_DIGEST';
ALTER TYPE "NotificationType" ADD VALUE 'NEW_FOLLOWERS_DIGEST';
