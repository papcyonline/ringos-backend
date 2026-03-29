import OpenAI, { toFile } from 'openai';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { downloadFromDrive } from '../../shared/gdrive.service';
import { checkTranscription, incrementTranscription } from '../../shared/usage.service';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Transcribe a voice note message using OpenAI Whisper.
 * Caches the result in the message's metadata so repeat calls are free.
 */
export async function transcribeMessage(
  messageId: string,
  conversationId: string,
  userId: string,
): Promise<{ transcription: string }> {
  // Verify participant
  const participant = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId, leftAt: null },
  });
  if (!participant) throw new Error('Not a participant');

  // Get message
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { audioUrl: true, metadata: true, conversationId: true },
  });
  if (!message) throw new Error('Message not found');
  if (message.conversationId !== conversationId) throw new Error('Message not in conversation');
  if (!message.audioUrl) throw new Error('Not a voice message');

  // Check cache — cached results are always free (no limit consumed)
  const existing = message.metadata as Record<string, any> | null;
  if (existing?.transcription) {
    return { transcription: existing.transcription };
  }

  // Gate non-cached transcriptions behind daily limit
  const txCheck = await checkTranscription(userId);
  if (!txCheck.allowed) {
    throw Object.assign(new Error('Daily transcription limit reached'), { code: 'TRANSCRIPTION_LIMIT' });
  }

  // Extract Drive file ID from /media/gdrive/<fileId>
  const match = message.audioUrl.match(/\/media\/gdrive\/(.+)/);
  if (!match) throw new Error('Audio not stored on Drive');

  const fileId = match[1];
  const downloaded = await downloadFromDrive(fileId);
  if (!downloaded) throw new Error('Failed to download audio');

  // Send to Whisper
  const file = await toFile(downloaded.buffer, 'audio.m4a', { type: downloaded.mimeType });
  const result = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
  });

  const transcription = result.text;
  if (!transcription) throw new Error('Transcription returned empty');

  // Track usage after successful transcription
  await incrementTranscription(userId);

  // Save to metadata (merge with existing)
  const merged = { ...(existing || {}), transcription };
  await prisma.message.update({
    where: { id: messageId },
    data: { metadata: merged },
  });

  // Broadcast to conversation
  const io = getIO();
  io.to(`conversation:${conversationId}`).emit('chat:transcribed', {
    messageId,
    transcription,
  });

  return { transcription };
}
