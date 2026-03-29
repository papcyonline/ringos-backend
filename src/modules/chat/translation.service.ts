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
/**
 * Only translate content that is clearly a real sentence in a real language.
 * Skip everything else: slang, numbers, emoji, URLs, short fragments, etc.
 */
function shouldSkipTranslation(content: string): boolean {
  const text = content.trim();

  // Strip emoji, URLs, phone numbers, and punctuation to get just "words"
  const cleaned = text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]/gu, '') // emoji
    .replace(/https?:\/\/\S+/gi, '')   // URLs
    .replace(/[\d\s\-+().]+/g, ' ')    // numbers / phone numbers
    .replace(/[^\p{L}\s]/gu, '')       // keep only letters and spaces
    .trim();

  // Nothing meaningful left after stripping
  if (!cleaned) return true;

  // Split into words (sequences of letters)
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);

  // Need at least 1 real word to be worth translating
  if (words.length < 1) return true;

  // If most "words" are very short (1-3 chars), it's likely slang/abbreviations
  const shortWords = words.filter(w => w.length <= 3).length;
  if (shortWords / words.length > 0.7) return true;

  return false;
}

export async function translateMessage(
  messageId: string,
  conversationId: string,
  content: string,
): Promise<void> {
  try {
    if (!content.trim()) return;
    if (shouldSkipTranslation(content)) return;

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
          .filter((p) => p.user != null)
          .flatMap((p) => (p.user.preference?.language ?? 'en').split(',').map((l: string) => l.trim()).filter(Boolean))
      ),
    ];

    if (targetLanguages.length === 0) return;

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
- Preserve emojis, @mentions, and formatting as-is
- Pidgin English (e.g. "How far", "Wetin dey happen", "I no sabi", "Na so e be") is English — detect it as "en" and do NOT translate it
- Internet shorthand and abbreviations (e.g. "u" = you, "r" = are, "pls" = please, "ngl", "brb", "omw", "wyd", "lol", "smh", "tbh", "imo") are English — detect as "en" and do NOT translate
- If the message is English written informally, with slang, shorthand, or pidgin, return empty translations: {"detectedLanguage":"en","translations":{}}`,
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

    // Persist to message metadata — merge with existing metadata
    const existing = await prisma.message.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    });
    const currentMetadata = (existing?.metadata as Record<string, unknown>) ?? {};
    await prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...currentMetadata,
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
