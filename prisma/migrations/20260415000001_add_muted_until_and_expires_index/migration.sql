-- AlterTable
ALTER TABLE "ConversationParticipant" ADD COLUMN IF NOT EXISTS "mutedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_expiresAt_idx" ON "Message"("expiresAt");
