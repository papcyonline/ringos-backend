import { logger } from './logger';

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

// Patterns use word boundaries (\b) where the term could appear as a
// substring of innocent words (e.g. "ass" in "classic"), and no boundary
// where the prefix is always explicit (e.g. "ejaculat-").
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
  /\bncest\b/,
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

const SIGHTENGINE_USER = process.env.SIGHTENGINE_API_USER;
const SIGHTENGINE_SECRET = process.env.SIGHTENGINE_API_SECRET;

export const isModerationConfigured = !!(SIGHTENGINE_USER && SIGHTENGINE_SECRET);

// Threshold above which content is considered unsafe (0.0 - 1.0)
const NUDITY_THRESHOLD = 0.6;
const OFFENSIVE_THRESHOLD = 0.7;

export interface ModerationResult {
  safe: boolean;
  reason?: string;
  scores?: {
    nudity?: number;
    offensive?: number;
    weapon?: number;
    drugs?: number;
  };
}

/**
 * Check an image buffer against Sightengine's moderation API by
 * posting the raw bytes (multipart/form-data).
 *
 * Prefer this over [moderateImageUrl] when the image isn't yet in
 * publicly addressable storage — avatar uploads overwrite the user's
 * canonical URL, so checking AFTER upload would leave an unsafe file
 * at that URL even if we then reject. With buffer moderation we can
 * decide BEFORE the bytes ever land in storage.
 *
 * Returns { safe: true } if no API key is configured (fail open).
 */
export async function moderateImageBuffer(
  buffer: Buffer,
  filename: string = 'upload.jpg',
): Promise<ModerationResult> {
  if (!isModerationConfigured) return { safe: true };

  try {
    const form = new FormData();
    form.append('media', new Blob([buffer]), filename);
    form.append('models', 'nudity-2.1,offensive,weapon,recreational_drug');
    form.append('api_user', SIGHTENGINE_USER!);
    form.append('api_secret', SIGHTENGINE_SECRET!);

    const response = await fetch('https://api.sightengine.com/1.0/check.json', {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Sightengine API error (buffer)');
      return { safe: true };
    }

    const data = await response.json() as any;
    if (data.status !== 'success') {
      logger.warn({ data }, 'Sightengine returned non-success status (buffer)');
      return { safe: true };
    }

    const nudity = data.nudity || {};
    const nudityScore = Math.max(
      nudity.sexual_activity || 0,
      nudity.sexual_display || 0,
      nudity.erotica || 0,
    );
    const offensive = data.offensive?.prob || 0;
    const weapon = data.weapon || 0;
    const drugs = data.recreational_drug?.prob || 0;
    const scores = { nudity: nudityScore, offensive, weapon, drugs };

    if (nudityScore > NUDITY_THRESHOLD) {
      return { safe: false, reason: 'Content contains nudity or sexual content', scores };
    }
    if (offensive > OFFENSIVE_THRESHOLD) {
      return { safe: false, reason: 'Content contains offensive material', scores };
    }
    if (weapon > 0.8) {
      return { safe: false, reason: 'Content contains weapons', scores };
    }
    return { safe: true, scores };
  } catch (err) {
    logger.error({ err }, 'Buffer moderation check failed');
    return { safe: true };
  }
}

/**
 * Check an image URL against Sightengine's moderation API.
 * Returns { safe: true } if no API key is configured (fail open).
 */
export async function moderateImageUrl(imageUrl: string): Promise<ModerationResult> {
  if (!isModerationConfigured) return { safe: true };

  try {
    const params = new URLSearchParams({
      url: imageUrl,
      models: 'nudity-2.1,offensive,weapon,recreational_drug',
      api_user: SIGHTENGINE_USER!,
      api_secret: SIGHTENGINE_SECRET!,
    });

    const response = await fetch(`https://api.sightengine.com/1.0/check.json?${params}`);
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Sightengine API error');
      return { safe: true }; // fail open on API errors
    }

    const data = await response.json() as any;
    if (data.status !== 'success') {
      logger.warn({ data }, 'Sightengine returned non-success status');
      return { safe: true };
    }

    // Sightengine nudity-2.1: sexual_activity, sexual_display, erotica, very_suggestive
    const nudity = data.nudity || {};
    const nudityScore = Math.max(
      nudity.sexual_activity || 0,
      nudity.sexual_display || 0,
      nudity.erotica || 0,
    );

    const offensive = data.offensive?.prob || 0;
    const weapon = data.weapon || 0;
    const drugs = data.recreational_drug?.prob || 0;

    const scores = { nudity: nudityScore, offensive, weapon, drugs };

    if (nudityScore > NUDITY_THRESHOLD) {
      return { safe: false, reason: 'Content contains nudity or sexual content', scores };
    }
    if (offensive > OFFENSIVE_THRESHOLD) {
      return { safe: false, reason: 'Content contains offensive material', scores };
    }
    if (weapon > 0.8) {
      return { safe: false, reason: 'Content contains weapons', scores };
    }

    return { safe: true, scores };
  } catch (err) {
    logger.error({ err, imageUrl }, 'Moderation check failed');
    return { safe: true }; // fail open
  }
}

/**
 * Check a video URL by sampling frames.
 * Sightengine's video moderation uses a separate endpoint with frame sampling.
 */
export async function moderateVideoUrl(videoUrl: string): Promise<ModerationResult> {
  if (!isModerationConfigured) return { safe: true };

  try {
    const params = new URLSearchParams({
      stream_url: videoUrl,
      models: 'nudity-2.1,offensive,weapon',
      api_user: SIGHTENGINE_USER!,
      api_secret: SIGHTENGINE_SECRET!,
    });

    // Synchronous video check — samples frames and returns aggregated result
    const response = await fetch(`https://api.sightengine.com/1.0/video/check-sync.json?${params}`);
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Sightengine video API error');
      return { safe: true };
    }

    const data = await response.json() as any;
    if (data.status !== 'success') {
      logger.warn({ data }, 'Sightengine video returned non-success status');
      return { safe: true };
    }

    // For video, data.data.frames is an array of frame analyses
    const frames = data.data?.frames || [];
    let maxNudity = 0;
    let maxOffensive = 0;
    let maxWeapon = 0;

    for (const frame of frames) {
      const nudity = frame.nudity || {};
      const frameNudity = Math.max(
        nudity.sexual_activity || 0,
        nudity.sexual_display || 0,
        nudity.erotica || 0,
      );
      maxNudity = Math.max(maxNudity, frameNudity);
      maxOffensive = Math.max(maxOffensive, frame.offensive?.prob || 0);
      maxWeapon = Math.max(maxWeapon, frame.weapon || 0);
    }

    const scores = { nudity: maxNudity, offensive: maxOffensive, weapon: maxWeapon };

    if (maxNudity > NUDITY_THRESHOLD) {
      return { safe: false, reason: 'Video contains nudity or sexual content', scores };
    }
    if (maxOffensive > OFFENSIVE_THRESHOLD) {
      return { safe: false, reason: 'Video contains offensive material', scores };
    }
    if (maxWeapon > 0.8) {
      return { safe: false, reason: 'Video contains weapons', scores };
    }

    return { safe: true, scores };
  } catch (err) {
    logger.error({ err, videoUrl }, 'Video moderation check failed');
    return { safe: true };
  }
}
