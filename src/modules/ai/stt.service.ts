import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';

const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY! });

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<string> {
  const audioBase64 = audioBuffer.toString('base64');

  const response = await gemini.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: 'Transcribe this audio exactly as spoken. Return only the transcribed text, nothing else.',
          },
        ],
      },
    ],
  });

  return response.text?.trim() ?? '';
}
