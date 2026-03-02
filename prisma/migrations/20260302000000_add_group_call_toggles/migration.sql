-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "callsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Conversation" ADD COLUMN "videoEnabled" BOOLEAN NOT NULL DEFAULT true;
