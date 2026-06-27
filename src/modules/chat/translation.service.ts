import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { createOpenAIClient } from '../../config/openai';
import { logger } from '../../shared/logger';

// Translation is fast; don't hang on the 10-min SDK default.
const openai = createOpenAIClient({ timeout: 30_000, maxRetries: 3 });

/**
 * True for transient network/stream errors that are safe to retry.
 * The OpenAI SDK's built-in retries only wrap the fetch itself — a
 * "Premature close" (ERR_STREAM_PREMATURE_CLOSE) happens later, while the
 * response body is being read, so it escapes the SDK and must be retried here.
 */
function isRetryableNetworkError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string } } | undefined;
  if (!e) return false;
  const code = e.code ?? e.cause?.code;
  if (code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EPIPE') return true;
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError' || e.name === 'FetchError') return true;
  return typeof e.message === 'string' && /premature close|socket hang up|network|terminated/i.test(e.message);
}

/**
 * Run an OpenAI call with bounded retries + exponential backoff on transient
 * network/stream errors (e.g. dropped keep-alive connections to OpenAI).
 */
async function withNetworkRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryableNetworkError(err)) throw err;
      const delayMs = 300 * 2 ** i; // 300ms, 600ms, 1200ms
      logger.warn({ err, attempt: i + 1, delayMs }, 'Translation OpenAI call failed (transient) — retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

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
    if (shouldSkipTranslation(content)) {
      logger.info({ messageId, content }, 'TRANSLATE_DEBUG skipped (heuristic: not a real sentence)');
      return;
    }

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

    logger.info({ messageId, conversationId, targetLanguages, content }, 'TRANSLATE_DEBUG participant languages');

    if (targetLanguages.length === 0) return;

    // If only one participant language, still proceed — the message might be
    // written in a different language than the participants speak.
    // We'll detect first, then decide whether to translate.

    const langList = targetLanguages.join(', ');

    const response = await withNetworkRetry(() => openai.chat.completions.create({
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
- ALWAYS translate normal, conversational messages into every target language that differs from the detected one. Casual or informal phrasing still counts — e.g. "Hello there my friend, how are you doing?" MUST be translated. Do not skip a message just because it is casual.
- The ONLY messages you skip (return the detected language with "translations":{}) are ones written ENTIRELY in:
  - Nigerian/West-African pidgin (e.g. "How far", "Wetin dey happen", "I no sabi", "Na so e be") — detect as "en", do NOT translate, OR
  - pure internet shorthand/abbreviations with no real words (e.g. "u r", "pls", "ngl", "brb", "omw", "wyd", "lol", "smh", "tbh", "imo") — detect as "en", do NOT translate
- A message that contains ordinary words is NOT in those categories and MUST be translated.`,
        },
        {
          role: 'user',
          content,
        },
      ],
      temperature: 0,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    }));

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return;

    const parsed = JSON.parse(text) as {
      detectedLanguage: string;
      translations: Record<string, string>;
    };

    if (!parsed.detectedLanguage || !parsed.translations) return;

    // Remove source language from translations if included
    delete parsed.translations[parsed.detectedLanguage];

    logger.info(
      { messageId, detected: parsed.detectedLanguage, translationKeys: Object.keys(parsed.translations) },
      'TRANSLATE_DEBUG detection result',
    );

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
