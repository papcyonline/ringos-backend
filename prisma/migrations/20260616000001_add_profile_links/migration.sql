-- Add flexible profile links (website/email/phone/socials) as JSONB.
ALTER TABLE "User" ADD COLUMN "profileLinks" JSONB;
