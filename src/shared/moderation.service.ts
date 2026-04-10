import { logger } from './logger';

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
