-- Client-generated dedup key. Clients generate a UUID at compose time
-- and include it on every send / retry. The unique index lets the
-- backend short-circuit on retried sends so a flaky network can't
-- create duplicate messages.
ALTER TABLE "Message" ADD COLUMN "clientMsgId" TEXT;
CREATE UNIQUE INDEX "Message_clientMsgId_key" ON "Message"("clientMsgId");
