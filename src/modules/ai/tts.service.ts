import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';

const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY! });

/**
 * Convert text to speech using Google Gemini TTS.
 * Returns an audio Buffer (mp3).
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await gemini.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: 'Kore',
          },
        },
      },
    },
  });

  // Extract inline audio data from response
  const parts = response.candidates?.[0]?.content?.parts;
  if (parts) {
    for (const part of parts) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }
  }

  throw new Error('No audio data in TTS response');
}
