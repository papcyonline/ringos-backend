import OpenAI, { toFile } from 'openai';
import { env } from '../../config/env';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<string> {
  const ext = mimeType.includes('wav')
    ? 'wav'
    : mimeType.includes('mp3') || mimeType.includes('mpeg')
      ? 'mp3'
      : mimeType.includes('mp4') || mimeType.includes('m4a')
        ? 'm4a'
        : 'webm';

  const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType });

  const transcription = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    prompt: 'This is a conversation with Kora, an AI companion in the Yomeet app.',
  });

  return transcription.text;
}
