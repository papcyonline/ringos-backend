-- Re-engagement campaign log. One row per (user, cadence step) so the
-- cron can dedupe across runs and guarantee each step (day 3 / 7 / 14
-- / 30 of inactivity) fires at most once per user.

CREATE TYPE "ReEngagementHook" AS ENUM (
  'UNREAD_DM',
  'NEW_FOLLOWER',
  'FOLLOWED_STORY',
  'NEW_JOINS',
  'GENERIC'
);

CREATE TABLE "ReEngagementPush" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "cadenceDay" INTEGER NOT NULL,
  "hookType"   "ReEngagementHook" NOT NULL,
  "sentAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReEngagementPush_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReEngagementPush_userId_cadenceDay_key"
  ON "ReEngagementPush"("userId", "cadenceDay");

CREATE INDEX "ReEngagementPush_sentAt_idx"
  ON "ReEngagementPush"("sentAt");

ALTER TABLE "ReEngagementPush"
  ADD CONSTRAINT "ReEngagementPush_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
