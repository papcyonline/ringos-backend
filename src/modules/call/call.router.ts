import { Router, Response } from 'express';
import twilio from 'twilio';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';

const router = Router();

// Free STUN servers (always included)
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const isTwilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
const isTurnConfigured = !!(env.TURN_SERVER_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL);

/** Build TURN server entries from env vars. */
function buildEnvTurnServers(): Array<{ urls: string; username: string; credential: string }> {
  if (!isTurnConfigured) return [];
  const urls = env.TURN_SERVER_URLS!.split(',').map((u) => u.trim());
  return urls.map((url) => ({
    urls: url,
    username: env.TURN_USERNAME!,
    credential: env.TURN_CREDENTIAL!,
  }));
}

// ─── Get Call Provider Info ──────────────────────────────────────────────────

router.get(
  '/provider',
  authenticate,
  (_req: AuthRequest, res: Response) => {
    res.json({ provider: 'webrtc' });
  }
);

// ─── Get ICE Server Configuration ───────────────────────────────────────────
// Returns STUN + TURN servers. Priority:
//   1. TURN_SERVER_URLS env vars (any TURN provider — recommended)
//   2. Twilio NTS ephemeral credentials (if configured)
//   3. STUN-only fallback (won't work across NATs / mobile carriers)

router.get(
  '/ice-servers',
  authenticate,
  async (_req: AuthRequest, res: Response) => {
    // 1. Custom TURN servers from env vars (highest priority)
    if (isTurnConfigured) {
      const servers = [...STUN_SERVERS, ...buildEnvTurnServers()];
      logger.info({ count: servers.length }, 'Returning env-configured TURN + STUN servers');
      res.json({ iceServers: servers });
      return;
    }

    // 2. Twilio NTS (ephemeral TURN credentials)
    if (isTwilioConfigured) {
      try {
        const client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
        const token = await client.tokens.create();
        logger.info('Returning Twilio NTS ICE servers');
        res.json({ iceServers: token.iceServers });
        return;
      } catch (err) {
        logger.error({ err }, 'Twilio NTS failed — falling back to STUN-only');
      }
    }

    // 3. STUN-only fallback (will NOT work across different networks)
    logger.warn('No TURN servers configured — calls will only work on the same network');
    res.json({ iceServers: STUN_SERVERS });
  }
);

// ─── Diagnostic: check if TURN is configured (no auth required) ─────────────
router.get('/turn-status', (_req, res: Response) => {
  res.json({
    turnConfigured: isTurnConfigured,
    twilioConfigured: isTwilioConfigured,
    turnUrlCount: isTurnConfigured ? env.TURN_SERVER_URLS!.split(',').length : 0,
  });
});

export { router as callRouter };
