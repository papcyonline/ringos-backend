-- Group content control: when true, only admins may post messages containing
-- links (URLs). Non-admin messages with a URL are rejected on send.
ALTER TABLE "Conversation" ADD COLUMN "adminsOnlyLinks" BOOLEAN NOT NULL DEFAULT false;
