import * as tf from '@tensorflow/tfjs-node';
import * as nsfwjs from 'nsfwjs';
import sharp from 'sharp';
import { logger } from './logger';
import { extractFrames } from './video.service';

// Re-exported for back-compat: the text filter lives in its own module so
// text-only importers don't pull in the TensorFlow stack below.
export { containsExplicitText } from './text-moderation.service';

// ─── Visual moderation (local, via NSFWJS) ───────────────────────────────────
//
// Nudity/sexual-content detection runs entirely IN-PROCESS using NSFWJS
// (MobileNetV2, bundled with the npm package — no network, no per-call cost,
// no external API). We classify raw image bytes / sampled video frames, so
// moderation never depends on a third party being able to FETCH our R2 URLs
// (the failure mode that used to silently delete legit video stories).
//
// Trade-off vs the old Sightengine integration: this model covers nudity /
// sexual content only (no weapon/drug/offensive categories). Text still uses
// containsExplicitText above.

// The model is loaded once, lazily, and cached. A failed load is not cached so
// the next request can retry.
let modelPromise: Promise<nsfwjs.NSFWJS> | null = null;
function getModel(): Promise<nsfwjs.NSFWJS> {
  if (!modelPromise) {
    modelPromise = nsfwjs.load().catch((err) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

// Moderation now runs locally, so it is always "configured". Kept as an export
// for call sites that gate on it (e.g. post.router).
export const isModerationConfigured = true;

// When a verdict can't be produced (model fails to load, a frame can't be
// decoded), do we allow the media through? Fail-OPEN = allow; fail-CLOSED =
// block. Default: fail-CLOSED in production so a broken model can't silently
// leak unmoderated media. Set MODERATION_FAIL_OPEN=true to override in an
// emergency. NOTE: video callers additionally let `unavailable` verdicts
// through regardless (see story/reel/post) since a codec we can't decode is
// not a content decision and the clip is already normalized to H.264.
const MODERATION_FAIL_OPEN =
  process.env.MODERATION_FAIL_OPEN === 'true' ||
  (process.env.MODERATION_FAIL_OPEN !== 'false' && process.env.NODE_ENV !== 'production');

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

// Bound concurrent VIDEO moderation. Each one spawns ffmpeg (decoding the whole
// clip) and runs a batch of TF classifications — heavy on CPU/RAM. Without a
// limit, a burst of simultaneous reel/story uploads could OOM a small instance.
// Images are far lighter (one classify, no ffmpeg) and left unbounded.
const MAX_CONCURRENT_VIDEO = Number(process.env.MODERATION_VIDEO_CONCURRENCY) || 2;
let videoActive = 0;
const videoQueue: Array<() => void> = [];
function pumpVideoQueue(): void {
  if (videoActive < MAX_CONCURRENT_VIDEO && videoQueue.length > 0) {
    videoActive++;
    videoQueue.shift()!();
  }
}
async function withVideoSlot<T>(fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    videoQueue.push(resolve);
    pumpVideoQueue();
  });
  try {
    return await fn();
  } finally {
    videoActive--;
    pumpVideoQueue();
  }
}

// Block when the combined Porn/Hentai probability crosses this. NSFWJS's
// "Sexy" class (bikini / cleavage / lingerie) is deliberately NOT blocked — it
// false-positives heavily on ordinary selfies and beach photos, matching the
// prior policy of not blocking merely-suggestive content.
const EXPLICIT_THRESHOLD = 0.7;

export interface ModerationResult {
  safe: boolean;
  /**
   * True when no real verdict could be produced (model unavailable, or a codec
   * the moderator can't decode) — as opposed to a genuine "unsafe" content
   * decision. Callers can choose to let such media through (e.g. for video,
   * which we've already normalized to H.264) instead of showing the user a
   * false "violates guidelines" rejection.
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

interface NsfwScores {
  porn: number;
  hentai: number;
  sexy: number;
  neutral: number;
  drawing: number;
}

function toScores(preds: { className: string; probability: number }[]): NsfwScores {
  const get = (n: string) => preds.find((p) => p.className === n)?.probability ?? 0;
  return {
    porn: get('Porn'),
    hentai: get('Hentai'),
    sexy: get('Sexy'),
    neutral: get('Neutral'),
    drawing: get('Drawing'),
  };
}

/** Turn NSFWJS class probabilities into a ModerationResult. */
function verdictFromNsfw(s: NsfwScores, subject: 'Content' | 'Video'): ModerationResult {
  const explicit = Math.max(s.porn, s.hentai);
  const scores = { nudity: explicit };

  // Log the breakdown on a block or a near-miss so thresholds can be retuned
  // against real production data instead of guesses.
  if (explicit > EXPLICIT_THRESHOLD - 0.15) {
    logger.info(
      { porn: s.porn, hentai: s.hentai, sexy: s.sexy, explicit, unsafe: explicit >= EXPLICIT_THRESHOLD },
      'moderation score',
    );
  }

  if (explicit >= EXPLICIT_THRESHOLD) {
    return { safe: false, reason: `${subject} contains nudity or sexual content`, scores };
  }
  return { safe: true, scores };
}

/** Decode + classify a single image buffer. Throws if the model or decode fails. */
async function classifyBuffer(buffer: Buffer): Promise<NsfwScores> {
  const model = await getModel();
  // Normalize ANY input to a plain RGB JPEG first. tf.node.decodeImage only
  // handles JPEG/PNG/GIF/BMP (and returns a 4D tensor for animated GIFs), so
  // raw uploads that are HEIC/HEIF (iOS), WebP, or animated would otherwise
  // throw and get falsely blocked. sharp collapses animation to the first
  // frame, applies EXIF rotation, and flattens alpha onto white.
  const jpeg = await sharp(buffer, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg()
    .toBuffer();
  const img = tf.node.decodeImage(jpeg, 3) as tf.Tensor3D;
  try {
    const preds = await model.classify(img);
    return toScores(preds);
  } finally {
    img.dispose();
  }
}

/**
 * Moderate raw image bytes. Preferred everywhere the bytes are already in hand
 * (avatars, covers, story/post images) — no URL fetch, so it can't be defeated
 * by storage-reachability issues.
 */
export async function moderateImageBuffer(
  buffer: Buffer,
  _filename: string = 'upload.jpg',
): Promise<ModerationResult> {
  try {
    return verdictFromNsfw(await classifyBuffer(buffer), 'Content');
  } catch (err) {
    logger.error({ err }, 'Image moderation (buffer) failed');
    return moderationUnavailable('exception (image buffer)');
  }
}

/** Moderate an image by URL — downloads the bytes, then classifies locally. */
export async function moderateImageUrl(imageUrl: string): Promise<ModerationResult> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return moderationUnavailable(`fetch ${res.status} (image url)`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return moderateImageBuffer(buffer);
  } catch (err) {
    logger.error({ err, imageUrl }, 'Image moderation (url) failed');
    return moderationUnavailable('exception (image url)');
  }
}

/**
 * Moderate a video from its raw bytes: sample frames with ffmpeg and classify
 * each, taking the worst. Preferred over [moderateVideoUrl] wherever the buffer
 * is available (story, reel) — no fetch of our own storage required.
 */
export async function moderateVideoBuffer(buffer: Buffer, ext = '.mp4'): Promise<ModerationResult> {
  return withVideoSlot(async () => {
    try {
      const frames = await extractFrames(buffer, { ext });
      if (frames.length === 0) return moderationUnavailable('no frames decoded (video)');

      let worst: NsfwScores = { porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0 };
      let classified = 0;
      for (const frame of frames) {
        let s: NsfwScores;
        try {
          s = await classifyBuffer(frame);
        } catch {
          continue; // skip an undecodable frame rather than fail the whole video
        }
        classified++;
        if (Math.max(s.porn, s.hentai) > Math.max(worst.porn, worst.hentai)) worst = s;
      }
      // If frames existed but NONE classified (e.g. the model can't load), that's
      // an outage — not a clean "safe" verdict. Report unavailable so it's logged
      // and the fail-open/closed policy applies, instead of silently passing.
      if (classified === 0) return moderationUnavailable('no frames classified (video)');
      return verdictFromNsfw(worst, 'Video');
    } catch (err) {
      logger.error({ err }, 'Video moderation (buffer) failed');
      return moderationUnavailable('exception (video buffer)');
    }
  });
}

/** Moderate a video by URL — downloads it, then samples/classifies frames. */
export async function moderateVideoUrl(videoUrl: string): Promise<ModerationResult> {
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return moderationUnavailable(`fetch ${res.status} (video url)`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const m = videoUrl.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    return moderateVideoBuffer(buffer, m ? `.${m[1]}` : '.mp4');
  } catch (err) {
    logger.error({ err, videoUrl }, 'Video moderation (url) failed');
    return moderationUnavailable('exception (video url)');
  }
}
