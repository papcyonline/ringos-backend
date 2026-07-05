-- Chat scam detection: warn + flag (never blocks a message).
-- Additive only — safe on a live table.

-- Recipient-facing safety banner flag on a message.
ALTER TABLE "Message" ADD COLUMN "scamWarning" BOOLEAN NOT NULL DEFAULT false;

-- Internal review queue for auto-flagged messages. Deliberately relation-less
-- (plain IDs) and off the automated report/ban ladder.
CREATE TABLE "ScamFlag" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "snippet" TEXT NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScamFlag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScamFlag_senderId_createdAt_idx" ON "ScamFlag"("senderId", "createdAt");
CREATE INDEX "ScamFlag_reviewed_createdAt_idx" ON "ScamFlag"("reviewed", "createdAt");
