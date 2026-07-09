-- Tracks when the user last opened their message-requests inbox, so the
-- "you have N message requests" push digest only counts requests that arrived
-- since then. Additive + nullable (NULL = never checked).
ALTER TABLE "User" ADD COLUMN "lastRequestCheckAt" TIMESTAMP(3);
