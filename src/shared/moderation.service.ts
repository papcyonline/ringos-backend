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

// ─── Visual moderation (OpenAI omni-moderation, off-server) ──────────────────
//
// Image/video nudity + graphic-violence detection runs via OpenAI's FREE
// moderation endpoint (`omni-moderation-latest`). We send image bytes as a
// base64 data URL, so it never needs to FETCH our storage (the failure that
// used to delete legit video stories). It's a plain HTTP call — nothing heavy
// runs on our server. Video = sample a few frames (ffmpeg) and check the worst.

export const isModerationConfigured = !!env.OPENAI_API_KEY;

// Fail-OPEN = allow when a verdict can't be produced; fail-CLOSED = block.
// Default fail-CLOSED in production so an outage can't silently leak content.
// Video callers additionally let `unavailable` through (a rare fallback).
const MODERATION_FAIL_OPEN =
  process.env.MODERATION_FAIL_OPEN === 'true' ||
  (process.env.MODERATION_FAIL_OPEN !== 'false' && process.env.NODE_ENV !== 'production');

// Block thresholds on OpenAI category scores (0..1).
const SEXUAL_THRESHOLD = 0.7;
const GRAPHIC_THRESHOLD = 0.85; // violence/graphic (gore)
const MINORS_THRESHOLD = 0.3; // sexual/minors — highest liability, low bar

// Cap frames per video: they go in ONE moderation request, and fewer frames
// keeps the payload + latency small. Env-tunable.
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
  scores?: {
    nudity?: number;
    offensive?: number;
    weapon?: number;
    drugs?: number;
  };
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  // Bound latency: the reel path awaits moderation synchronously, so a slow or
  // stuck OpenAI call must fail fast (→ unavailable → upload proceeds) rather
  // than hang on the SDK's default 10-min timeout / multiple retries.
  if (!client) client = createOpenAIClient({ timeout: 15_000, maxRetries: 1 });
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
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

interface Signals {
  sexual: number;
  graphic: number;
  minors: number;
}

/** Turn one OpenAI moderation result's category scores into worst-signal numbers. */
function signalsFrom(scores: Record<string, number>): Signals {
  return {
    sexual: scores['sexual'] ?? 0,
    graphic: scores['violence/graphic'] ?? 0,
    minors: scores['sexual/minors'] ?? 0,
  };
}

function verdictFrom(worst: Signals, subject: 'Content' | 'Video'): ModerationResult {
  const scores = { nudity: worst.sexual };
  const unsafe =
    worst.sexual >= SEXUAL_THRESHOLD ||
    worst.graphic >= GRAPHIC_THRESHOLD ||
    worst.minors >= MINORS_THRESHOLD;

  if (unsafe || worst.sexual > SEXUAL_THRESHOLD - 0.15) {
    logger.info(
      { sexual: worst.sexual, graphic: worst.graphic, minors: worst.minors, unsafe },
      'moderation score',
    );
  }

  // Sexual content involving minors is the highest-liability class — block it
  // at a low threshold. (Note: omni-moderation scores this mainly on text; on
  // image-only inputs it's usually 0, so this is best-effort insurance.)
  if (worst.minors >= MINORS_THRESHOLD) {
    return { safe: false, reason: `${subject} contains prohibited sexual content`, scores };
  }
  if (worst.sexual >= SEXUAL_THRESHOLD) {
    return { safe: false, reason: `${subject} contains nudity or sexual content`, scores };
  }
  if (worst.graphic >= GRAPHIC_THRESHOLD) {
    return { safe: false, reason: `${subject} contains graphic violence`, scores };
  }
  return { safe: true, scores };
}

/**
 * Moderate one or more images (as JPEG data URLs) and return the worst signal
 * across them. The moderation endpoint accepts only ONE image per request, so
 * we fire one request per image in parallel. Returns null only if EVERY request
 * failed (caller maps null → unavailable); individual failures are skipped.
 */
async function moderateDataUrls(dataUrls: string[]): Promise<Signals | null> {
  if (dataUrls.length === 0) return null;
  const settled = await Promise.all(
    dataUrls.map(async (url) => {
      try {
        const res = await getClient().moderations.create({
          model: 'omni-moderation-latest',
          input: [{ type: 'image_url' as const, image_url: { url } }],
        });
        const first = res.results?.[0];
        if (!first) return null;
        return signalsFrom(first.category_scores as unknown as Record<string, number>);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'OpenAI moderation request failed');
        return null;
      }
    }),
  );
  const ok = settled.filter((s): s is Signals => s !== null);
  if (ok.length === 0) return null;
  const worst: Signals = { sexual: 0, graphic: 0, minors: 0 };
  for (const s of ok) {
    if (s.sexual > worst.sexual) worst.sexual = s.sexual;
    if (s.graphic > worst.graphic) worst.graphic = s.graphic;
    if (s.minors > worst.minors) worst.minors = s.minors;
  }
  return worst;
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
  const worst = await moderateDataUrls([dataUrl]);
  if (!worst) return moderationUnavailable('api error (image)');
  return verdictFrom(worst, 'Content');
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
 * Moderate a video from its raw bytes: sample frames (ffmpeg), then check them
 * all in one moderation request. Preferred over [moderateVideoUrl] wherever the
 * buffer is available (story, reel) — no fetch of our own storage.
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

    const worst = await moderateDataUrls(dataUrls);
    if (!worst) return moderationUnavailable('api error (video)');
    return verdictFrom(worst, 'Video');
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
