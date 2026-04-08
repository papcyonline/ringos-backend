-- AlterTable
ALTER TABLE "ConversationParticipant" ADD COLUMN IF NOT EXISTS "bannedAt" TIMESTAMP(3);
