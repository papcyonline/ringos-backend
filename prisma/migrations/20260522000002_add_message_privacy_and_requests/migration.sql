-- Anti-harassment: per-user inbox gating + message-request queue.
--
-- MessagePrivacy controls who can DM the user at all. ConversationRequestStatus
-- tracks the lifecycle of a stranger-initiated DM until the recipient
-- accepts or declines. Existing conversations stay untouched (requestStatus
-- defaults NULL = "not a request"), so this rollout is non-breaking for
-- current data.

CREATE TYPE "MessagePrivacy" AS ENUM (
  'EVERYONE',
  'FOLLOWING',
  'NOBODY'
);

CREATE TYPE "ConversationRequestStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'DECLINED'
);

ALTER TABLE "User"
  ADD COLUMN "messagePrivacy" "MessagePrivacy" NOT NULL DEFAULT 'EVERYONE';

ALTER TABLE "Conversation"
  ADD COLUMN "requestStatus" "ConversationRequestStatus",
  ADD COLUMN "requestedById" TEXT,
  ADD COLUMN "acceptedAt"   TIMESTAMP(3),
  ADD COLUMN "declinedAt"   TIMESTAMP(3);

-- Index so listing pending requests for a user (a common query path)
-- doesn't have to scan the whole conversation table.
CREATE INDEX "Conversation_requestStatus_idx"
  ON "Conversation"("requestStatus")
  WHERE "requestStatus" IS NOT NULL;
