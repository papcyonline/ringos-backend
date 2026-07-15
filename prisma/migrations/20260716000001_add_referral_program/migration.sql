-- Referral program. Referrer earns free Pro time (User.proUntil) when invited
-- friends qualify. referralCode = the user's shareable invite code;
-- referralRewardTier = highest friend-count milestone already paid (0/5/10/30).
-- All additive + nullable (except the defaulted int/tier).
ALTER TABLE "User" ADD COLUMN "proUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referralRewardTier" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- One referral per referee (refereeId unique = set once, immutable).
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Referral_refereeId_key" ON "Referral"("refereeId");
CREATE INDEX "Referral_referrerId_status_idx" ON "Referral"("referrerId", "status");
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
