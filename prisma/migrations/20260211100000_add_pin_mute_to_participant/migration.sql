-- AlterTable
ALTER TABLE "ConversationParticipant" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "isMuted" BOOLEAN NOT NULL DEFAULT false;
