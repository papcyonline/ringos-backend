import sharp from 'sharp';
import type OpenAI from 'openai';
import { logger } from './logger';
import { env } from '../config/env';
import { createOpenAIClient } from '../config/openai';
import { extractFrames } from './video.service';

// ─── Text content filter ─────────────────────────────────────────────────────

// Common leet-speak substitutions applied before checking so people
// can't bypass the filter with "s3x" or "p0rn".
function normalizeLeet(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
}

const EXPLICIT_PATTERNS: RegExp[] = [
  /\bporn(ography|ographic|hub|star)?\b/,
  /\bxxx\b/,
  /\bnudes?\b/,
  /\bsexting\b/,
  /\bfuck(ing|er|s)?\b/,
  /\bcunt\b/,
  /\bcock\b/,
  /\bdick(s)?\b/,
  /\bpussy\b/,
  /\bboobs?\b/,
  /\btits?\b/,
  /\basshole\b/,
  /ejaculat/,
  /\bdildo\b/,
  /\bprostitut(e|ion)?\b/,
  /\bbdsm\b/,
  /\bblowjob\b/,
  /\bhandjob\b/,
  /\bhooker\b/,
  /\bwhore\b/,
  /\bslut\b/,
  /\bhorny\b/,
  /\bstripper\b/,
  /\bcumshot\b/,
  /\bfetish\b/,
  /\bonlyfans\b/,
  /\bmilf\b/,
  /\bshemale\b/,
  /\bsex.?worker\b/,
  /\berotic(a)?\b/,
  /\bincest\b/,
  /\bpedophil/,
];

/**
 * Returns true when the text contains explicit sexual content or porn
 * references — including common leet-speak obfuscations.
 */
export function containsExplicitText(text: string): boolean {
  const normalized = normalizeLeet(text);
  return EXPLICIT_PATTERNS.some((p) => p.test(normalized));
}

// ─── Visual moderation (GPT-4o-mini vision, off-server) ──────────────────────
//
// Images + video frames are classified by GPT-4o-mini with a strict moderation
// prompt (validated ~100% on a nudity/weapon/drug/violence + false-positive set).
// We send bytes as a base64 data URL, so it never fetches our storage. It's a
// plain HTTP call — nothing heavy on our server. Video = sample a few frames
// (ffmpeg) and flag if ANY frame is prohibited. Chosen over the free
// omni-moderation endpoint (no weapons category) and over Gemini (too slow,
// 7-15s/image). Cost is a fraction of a cent per image (detail:'low').

const MODERATION_MODEL = process.env.MODERATION_MODEL || 'gpt-4o-mini';

const CATEGORIES = ['nudity', 'weapons', 'drugs', 'violence'] as const;
type Category = (typeof CATEGORIES)[number];
type Flags = Record<Category, boolean>;

const MOD_PROMPT =
  'You are a strict content moderator for a social app. Look at the image and ' +
  'return ONLY JSON: {"nudity":bool,"weapons":bool,"drugs":bool,"violence":bool}. ' +
  'nudity = sexual/explicit content, exposed genitals, or exposed female breasts. ' +
  'weapons = any firearm, knife, or weapon. ' +
  'drugs = illegal drugs, pills, or drug use/paraphernalia. ' +
  'violence = graphic violence, gore, or blood. ' +
  'Ordinary photos (people clothed, beach, food, scenery) are all false.';

export const isModerationConfigured = !!env.OPENAI_API_KEY;

// Fail-OPEN = allow when a verdict can't be produced; fail-CLOSED = block.
// Default fail-CLOSED in production. Video callers additionally let
// `unavailable` through. Set MODERATION_FAIL_OPEN=true to never block on error.
const MODERATION_FAIL_OPEN =
  process.env.MODERATION_FAIL_OPEN === 'true' ||
  (process.env.MODERATION_FAIL_OPEN !== 'false' && process.env.NODE_ENV !== 'production');

// Frames sampled per video (each is one classify call, run in parallel).
const VIDEO_FRAMES = Number(process.env.MODERATION_VIDEO_FRAMES) || 6;

export interface ModerationResult {
  safe: boolean;
  /**
   * True when no real verdict could be produced (API down/rate-limited, or a
   * codec we couldn't decode) — as opposed to a genuine "unsafe" decision.
   * Callers can let such media through instead of a false rejection.
   */
  unavailable?: boolean;
  reason?: string;
  /** Which prohibited categories were detected (present on an unsafe verdict). */
  categories?: Category[];
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  // Bound latency: the reel path awaits moderation synchronously, so a slow or
  // stuck call must fail fast (→ unavailable → upload proceeds) rather than
  // hang on the SDK's default 10-min timeout / multiple retries.
  if (!client) client = createOpenAIClient({ timeout: 20_000, maxRetries: 1 });
  return client;
}

/** Verdict to return when moderation can't run. Logs loudly so outages are visible. */
function moderationUnavailable(reason: string): ModerationResult {
  if (MODERATION_FAIL_OPEN) {
    logger.warn({ reason }, 'Moderation unavailable — failing OPEN (content allowed)');
    return { safe: true, unavailable: true };
  }
  logger.error({ reason }, 'Moderation unavailable — failing CLOSED (content blocked)');
  return {
    safe: false,
    unavailable: true,
    reason: 'Content moderation is temporarily unavailable. Please try again.',
  };
}

/** sharp-normalize any input (HEIC/WebP/GIF/EXIF/alpha) to a JPEG data URL. */
async function toJpegDataUrl(buffer: Buffer): Promise<string> {
  const jpeg = await sharp(buffer, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/** Classify one image (data URL). Returns category flags, or null on failure. */
async function classifyDataUrl(url: string): Promise<Flags | null> {
  try {
    const res = await getClient().chat.completions.create({
      model: MODERATION_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: MOD_PROMPT },
            { type: 'image_url', image_url: { url, detail: 'low' } },
          ],
        },
      ],
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    const j = JSON.parse(content) as Record<string, unknown>;
    return {
      nudity: !!j.nudity,
      weapons: !!j.weapons,
      drugs: !!j.drugs,
      violence: !!j.violence,
    };
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Moderation classify failed');
    return null;
  }
}

/**
 * Classify one or more images and OR-combine the flags (any frame prohibited →
 * prohibited). One request per image, in parallel. Returns null only if EVERY
 * request failed (caller maps null → unavailable); individual failures skip.
 */
async function moderateDataUrls(dataUrls: string[]): Promise<Flags | null> {
  if (dataUrls.length === 0) return null;
  const settled = await Promise.all(dataUrls.map((url) => classifyDataUrl(url)));
  const ok = settled.filter((f): f is Flags => f !== null);
  if (ok.length === 0) return null;
  const combined: Flags = { nudity: false, weapons: false, drugs: false, violence: false };
  for (const f of ok) for (const c of CATEGORIES) if (f[c]) combined[c] = true;
  return combined;
}

function verdictFrom(flags: Flags, subject: 'Content' | 'Video'): ModerationResult {
  const hit = CATEGORIES.filter((c) => flags[c]);
  logger.info({ subject, nudity: flags.nudity, weapons: flags.weapons, drugs: flags.drugs, violence: flags.violence, unsafe: hit.length > 0 }, 'moderation result');
  if (hit.length > 0) {
    return { safe: false, reason: `${subject} contains prohibited content (${hit.join(', ')})`, categories: hit };
  }
  return { safe: true };
}

/**
 * Moderate raw image bytes. Preferred wherever the bytes are in hand (avatars,
 * covers, story/post images) — no URL fetch, so storage reachability is a
 * non-issue.
 */
export async function moderateImageBuffer(
  buffer: Buffer,
  _filename: string = 'upload.jpg',
): Promise<ModerationResult> {
  if (!isModerationConfigured) return moderationUnavailable('not configured');
  let dataUrl: string;
  try {
    dataUrl = await toJpegDataUrl(buffer);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Image decode (sharp) failed');
    return moderationUnavailable('image decode failed');
  }
  const flags = await moderateDataUrls([dataUrl]);
  if (!flags) return moderationUnavailable('api error (image)');
  return verdictFrom(flags, 'Content');
}

/** Moderate an image by URL — downloads the bytes, then classifies. */
export async function moderateImageUrl(imageUrl: string): Promise<ModerationResult> {
  if (!isModerationConfigured) return moderationUnavailable('not configured');
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return moderationUnavailable(`fetch ${res.status} (image url)`);
    return moderateImageBuffer(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    logger.error({ err: (err as Error).message, imageUrl }, 'Image moderation (url) failed');
    return moderationUnavailable('exception (image url)');
  }
}

/**
 * Moderate a video from its raw bytes: sample frames (ffmpeg), classify each in
 * parallel, flag if ANY is prohibited. Preferred over [moderateVideoUrl]
 * wherever the buffer is available (story, reel) — no fetch of our own storage.
 */
export async function moderateVideoBuffer(buffer: Buffer, ext = '.mp4'): Promise<ModerationResult> {
  if (!isModerationConfigured) return moderationUnavailable('not configured');
  try {
    const frames = await extractFrames(buffer, { maxFrames: VIDEO_FRAMES, ext });
    if (frames.length === 0) return moderationUnavailable('no frames decoded (video)');

    const dataUrls: string[] = [];
    for (const f of frames) {
      try {
        dataUrls.push(await toJpegDataUrl(f));
      } catch {
        /* skip an undecodable frame */
      }
    }
    if (dataUrls.length === 0) return moderationUnavailable('no frames encodable (video)');

    const flags = await moderateDataUrls(dataUrls);
    if (!flags) return moderationUnavailable('api error (video)');
    return verdictFrom(flags, 'Video');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Video moderation (buffer) failed');
    return moderationUnavailable('exception (video buffer)');
  }
}

/** Moderate a video by URL — downloads it, then samples/classifies frames. */
export async function moderateVideoUrl(videoUrl: string): Promise<ModerationResult> {
  if (!isModerationConfigured) return moderationUnavailable('not configured');
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return moderationUnavailable(`fetch ${res.status} (video url)`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const m = videoUrl.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    return moderateVideoBuffer(buffer, m ? `.${m[1]}` : '.mp4');
  } catch (err) {
    logger.error({ err: (err as Error).message, videoUrl }, 'Video moderation (url) failed');
    return moderationUnavailable('exception (video url)');
  }
}
