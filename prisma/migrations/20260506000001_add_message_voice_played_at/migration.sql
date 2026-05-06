-- Add voicePlayedAt to Message for the WhatsApp-style "listened" indicator.
-- Set on first play by any recipient via the chat:voice-played socket event;
-- read by the frontend to: drop the unplayed blue dot on the receiver's
-- bubble + flip the sender's mic icon from gray to blue.
ALTER TABLE "Message" ADD COLUMN "voicePlayedAt" TIMESTAMP(3);
