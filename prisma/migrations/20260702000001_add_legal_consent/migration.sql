-- Legal consent tracking: records each acceptance of the current legal version
-- (Terms / Privacy / Community Guidelines) for audit + re-consent on updates.
-- Additive + nullable — existing users are simply "behind" and re-prompted.
ALTER TABLE "User" ADD COLUMN "acceptedLegalVersion" INTEGER;

CREATE TABLE "LegalConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" TEXT,
    "appVersion" TEXT,
    CONSTRAINT "LegalConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LegalConsent_userId_idx" ON "LegalConsent"("userId");

ALTER TABLE "LegalConsent" ADD CONSTRAINT "LegalConsent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
