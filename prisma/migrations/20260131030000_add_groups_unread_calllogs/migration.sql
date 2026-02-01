-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallLogStatus" AS ENUM ('COMPLETED', 'MISSED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ConversationType" ADD VALUE 'GROUP';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "name" TEXT,
ADD COLUMN "avatarUrl" TEXT;

-- AlterTable
ALTER TABLE "ConversationParticipant" ADD COLUMN "role" "ParticipantRole" NOT NULL DEFAULT 'MEMBER',
ADD COLUMN "lastReadAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "callType" "CallType" NOT NULL DEFAULT 'AUDIO',
    "status" "CallLogStatus" NOT NULL DEFAULT 'MISSED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSecs" INTEGER,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_callId_key" ON "CallLog"("callId");

-- CreateIndex
CREATE INDEX "CallLog_conversationId_idx" ON "CallLog"("conversationId");

-- CreateIndex
CREATE INDEX "CallLog_initiatorId_idx" ON "CallLog"("initiatorId");

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
