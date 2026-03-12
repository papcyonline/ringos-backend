import OpenAI from 'openai';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Translate a message asynchronously after it has been sent.
 * Always detects the source language, then translates to all participant
 * languages that differ from the detected language.
 * Non-critical — failures are logged and silently ignored.
 */
export async function translateMessage(
  messageId: string,
  conversationId: string,
  content: string,
): Promise<void> {
  try {
    if (!content.trim()) return;

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

    // If only one participant language, still proceed — the message might be
    // written in a different language than the participants speak.
    // We'll detect first, then decide whether to translate.

    const langList = targetLanguages.join(', ');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a translation engine. Detect the language of the user's message, then translate it into each of these target languages: ${langList}.

Respond ONLY with valid JSON. Use this exact format:
{"detectedLanguage":"<iso-code>","translations":{"<lang1>":"<translated text>","<lang2>":"<translated text>"}}

Rules:
- Use ISO 639-1 two-letter language codes (e.g. "en", "fr", "es")
- Do NOT include a translation for the detected source language
- If the message is already in a target language, omit that language from translations
- Preserve emojis, @mentions, and formatting as-is`,
        },
        {
          role: 'user',
          content,
        },
      ],
      temperature: 0,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return;

    const parsed = JSON.parse(text) as {
      detectedLanguage: string;
      translations: Record<string, string>;
    };

    if (!parsed.detectedLanguage || !parsed.translations) return;

    // Remove source language from translations if included
    delete parsed.translations[parsed.detectedLanguage];

    // If no translations remain (message is already in the only target language), skip
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
