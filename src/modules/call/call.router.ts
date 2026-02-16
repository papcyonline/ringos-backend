import { Router, Response } from 'express';
import twilio from 'twilio';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';

const router = Router();

// Free STUN-only fallback (used when Twilio is not configured)
const STUN_ONLY_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

const isTwilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);

// ─── Get Call Provider Info ──────────────────────────────────────────────────

router.get(
  '/provider',
  authenticate,
  (_req: AuthRequest, res: Response) => {
    res.json({ provider: 'webrtc' });
  }
);

// ─── Get ICE Server Configuration ───────────────────────────────────────────
// Returns STUN + TURN servers. When Twilio is configured, generates
// ephemeral TURN credentials via Twilio's Network Traversal Service.
// Falls back to free STUN-only servers otherwise.

router.get(
  '/ice-servers',
  authenticate,
  async (_req: AuthRequest, res: Response) => {
    if (isTwilioConfigured) {
      try {
        const client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
        const token = await client.tokens.create();
        res.json({ iceServers: token.iceServers });
        return;
      } catch (err) {
        logger.error({ err }, 'Failed to fetch Twilio TURN credentials, falling back to STUN');
      }
    }

    // Fallback: STUN only
    res.json({ iceServers: STUN_ONLY_SERVERS });
  }
);

export { router as callRouter };
