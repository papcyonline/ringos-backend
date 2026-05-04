-- Add nullable dateOfBirth column to User. Required for COPPA / GDPR-K
-- compliance + App Store age-gating. Nullable so existing rows survive
-- the migration; the application's isProfileComplete() check now also
-- requires a non-null DOB, so existing users get prompted on next launch.
ALTER TABLE "User" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
