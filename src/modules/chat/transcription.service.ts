import OpenAI, { toFile } from 'openai';
import path from 'path';
import { promises as fs } from 'fs';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { downloadFromDrive } from '../../shared/gdrive.service';
import { checkTranscription, incrementTranscription } from '../../shared/usage.service';
import { AppError } from '../../shared/errors';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

interface AudioBlob {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Resolve a stored audio URL to its raw bytes regardless of which storage
 * tier it lives on. Mirrors the upload fallback chain in upload.ts:
 *   1. Google Drive    → /media/gdrive/<fileId>
 *   2. Cloudinary      → https://res.cloudinary.com/.../voice_notes/...
 *   3. Local disk      → /uploads/audio/<file>
 *
 * Returns null on failure so the caller can decide how to surface the
 * error to the user (we do not throw here so each branch's failure mode
 * is logged in one place).
 */
async function fetchAudioBytes(audioUrl: string): Promise<AudioBlob | null> {
  // 1. Google Drive
  const driveMatch = audioUrl.match(/\/media\/gdrive\/(.+)/);
  if (driveMatch) {
    const downloaded = await downloadFromDrive(driveMatch[1]);
    if (!downloaded) return null;
    return { buffer: downloaded.buffer, mimeType: downloaded.mimeType, filename: 'audio.m4a' };
  }

  // 2. Cloudinary (or any other absolute http(s) URL we host)
  if (/^https?:\/\//i.test(audioUrl)) {
    try {
      const res = await fetch(audioUrl);
      if (!res.ok) {
        logger.warn({ status: res.status, audioUrl }, 'Audio fetch failed');
        return null;
      }
      const ab = await res.arrayBuffer();
      const buffer = Buffer.from(ab);
      const mimeType = res.headers.get('content-type') ?? 'audio/mp4';
      const ext = path.extname(new URL(audioUrl).pathname) || '.m4a';
      return { buffer, mimeType, filename: `audio${ext}` };
    } catch (err) {
      logger.warn({ err, audioUrl }, 'Audio fetch threw');
      return null;
    }
  }

  // 3. Local disk fallback (/uploads/audio/<file>) — read directly from
  // the on-disk path. Only safe because the URL is server-issued; we
  // sanity-check it stays under uploads/.
  if (audioUrl.startsWith('/uploads/audio/')) {
    try {
      const safePath = path.posix.normalize(audioUrl);
      if (!safePath.startsWith('/uploads/audio/')) return null;
      const onDiskPath = path.join(process.cwd(), safePath.replace(/^\//, ''));
      const buffer = await fs.readFile(onDiskPath);
      const ext = path.extname(audioUrl) || '.m4a';
      return { buffer, mimeType: 'audio/mp4', filename: `audio${ext}` };
    } catch (err) {
      logger.warn({ err, audioUrl }, 'Local audio read failed');
      return null;
    }
  }

  logger.warn({ audioUrl }, 'Unknown audio URL scheme — cannot transcribe');
  return null;
}

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
    throw new AppError(429, 'Daily transcription limit reached', 'TRANSCRIPTION_LIMIT');
  }

  // Resolve audio bytes regardless of which storage tier hosts the file
  // (Google Drive / Cloudinary / local disk) — see fetchAudioBytes.
  const audio = await fetchAudioBytes(message.audioUrl);
  if (!audio) throw new Error('Failed to download audio');

  // Send to Whisper with verbose_json so we can inspect per-segment
  // no_speech_prob to detect audio Whisper cannot make sense of.
  const file = await toFile(audio.buffer, audio.filename, { type: audio.mimeType });
  const result = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    response_format: 'verbose_json',
  }) as { text: string; segments?: Array<{ no_speech_prob: number }> };

  const transcription = result.text?.trim();
  if (!transcription) throw new Error('Transcription returned empty');

  // Detect unintelligible audio: Whisper assigns high no_speech_prob when
  // it cannot find actual speech in the segment (noise, silence, or a
  // language it genuinely cannot decode). Average > 0.7 across all
  // segments is a reliable signal that nothing meaningful was understood.
  const segments = result.segments;
  if (segments && segments.length > 0) {
    const avgNoSpeech = segments.reduce((sum, s) => sum + s.no_speech_prob, 0) / segments.length;
    if (avgNoSpeech > 0.7) {
      throw new AppError(422, 'Language not understood', 'LANGUAGE_NOT_UNDERSTOOD');
    }
  }

  // Also catch the common Whisper hallucination pattern where it returns
  // only punctuation / whitespace for audio it cannot decode.
  if (/^[\s.,!?…\-–—]+$/.test(transcription)) {
    throw new AppError(422, 'Language not understood', 'LANGUAGE_NOT_UNDERSTOOD');
  }

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
