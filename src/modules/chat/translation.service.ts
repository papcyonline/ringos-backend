import { GoogleGenAI } from '@google/genai';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';

const gemini = env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })
  : null;

/**
 * Translate a message asynchronously after it has been sent.
 * Detects the source language and translates to all target languages
 * spoken by active participants in the conversation.
 * Non-critical — failures are logged and silently ignored.
 */
export async function translateMessage(
  messageId: string,
  conversationId: string,
  content: string,
): Promise<void> {
  try {
    if (!gemini || !content.trim()) return;

    // Get unique languages of all active participants
    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId, leftAt: null },
      select: {
        user: {
          select: {
            preference: { select: { language: true } },
          },
        },
      },
    });

    // Language field can be comma-separated (e.g. "en,fr"), so split and flatten
    const targetLanguages = [
      ...new Set(
        participants
          .flatMap((p) => (p.user.preference?.language ?? 'en').split(',').map((l: string) => l.trim()).filter(Boolean))
      ),
    ];

    // If everyone speaks the same single language, skip translation
    if (targetLanguages.length <= 1) return;

    const langList = targetLanguages.join(', ');

    const response = await gemini.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `You are a translation engine. Detect the language of the following message, then translate it into each of these target languages: ${langList}.

Message: "${content}"

Respond ONLY with valid JSON — no markdown, no code fences, no explanation. Use this exact format:
{"detectedLanguage":"<iso-code>","translations":{"<lang1>":"<translated text>","<lang2>":"<translated text>"}}

Rules:
- Use ISO 639-1 two-letter language codes (e.g. "en", "fr", "es")
- Do NOT include a translation for the detected source language
- If the message is already in a target language, omit that language from translations
- Preserve emojis, @mentions, and formatting as-is`,
    });

    const text = response.text?.trim();
    if (!text) return;

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

    const parsed = JSON.parse(cleaned) as {
      detectedLanguage: string;
      translations: Record<string, string>;
    };

    if (!parsed.detectedLanguage || !parsed.translations) return;

    // Remove source language from translations if Gemini included it
    delete parsed.translations[parsed.detectedLanguage];

    // If no translations remain, skip
    if (Object.keys(parsed.translations).length === 0) return;

    // Persist to message metadata
    await prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          detectedLanguage: parsed.detectedLanguage,
          translations: parsed.translations,
        },
      },
    });

    // Emit to conversation room so clients can update inline
    const io = getIO();
    io.to(`conversation:${conversationId}`).emit('chat:translated', {
      messageId,
      detectedLanguage: parsed.detectedLanguage,
      translations: parsed.translations,
    });
  } catch (err) {
    logger.warn({ err, messageId, conversationId }, 'Translation failed (non-critical)');
  }
}
