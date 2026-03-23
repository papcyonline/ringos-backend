import { Router, Response } from 'express';
import twilio from 'twilio';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { prisma } from '../../config/database';

const router = Router();

// Free STUN servers (always included)
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const isTwilioConfigured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
const isTurnConfigured = !!(env.TURN_SERVER_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL);

/** Normalize a TURN URL: auto-prepend `turn:` if no protocol prefix. */
function normalizeTurnUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('turn:') || trimmed.startsWith('turns:') || trimmed.startsWith('stun:')) {
    return trimmed;
  }
  return `turn:${trimmed}`;
}

/** Build TURN server entries from env vars, including TCP transport variant. */
function buildEnvTurnServers(): Array<{ urls: string; username: string; credential: string }> {
  if (!isTurnConfigured) return [];

  const rawUrls = env.TURN_SERVER_URLS!.split(',').map((u) => u.trim());
  const entries: Array<{ urls: string; username: string; credential: string }> = [];

  for (const raw of rawUrls) {
    const url = normalizeTurnUrl(raw);
    entries.push({ urls: url, username: env.TURN_USERNAME!, credential: env.TURN_CREDENTIAL! });

    // Also add TCP transport if not already specified (helps on networks that block UDP)
    if (!url.includes('transport=')) {
      entries.push({
        urls: `${url}?transport=tcp`,
        username: env.TURN_USERNAME!,
        credential: env.TURN_CREDENTIAL!,
      });
    }
  }

  return entries;
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

// ─── Diagnostic: check if TURN is configured (auth required) ────────────────
router.get('/turn-status', authenticate, (_req, res: Response) => {
  res.json({
    turnConfigured: isTurnConfigured,
    twilioConfigured: isTwilioConfigured,
  });
});

// ─── Call History ────────────────────────────────────────────────────────────
// Returns paginated call logs for the authenticated user, ordered by startedAt desc.
// The user must be a participant of the conversation associated with each call log.

router.get(
  '/history',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
      const skip = (page - 1) * limit;

      // Find all conversation IDs where this user is a participant
      const participantRows = await prisma.conversationParticipant.findMany({
        where: { userId, leftAt: null },
        select: { conversationId: true },
      });
      const conversationIds = participantRows.map((p) => p.conversationId);

      if (conversationIds.length === 0) {
        res.json([]);
        return;
      }

      const callLogs = await prisma.callLog.findMany({
        where: { conversationId: { in: conversationIds } },
        orderBy: { startedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          callId: true,
          callType: true,
          status: true,
          startedAt: true,
          endedAt: true,
          durationSecs: true,
          initiatorId: true,
          conversationId: true,
          conversation: {
            select: {
              id: true,
              type: true,
              name: true,
              avatarUrl: true,
              participants: {
                where: { leftAt: null },
                select: {
                  userId: true,
                  user: {
                    select: {
                      id: true,
                      displayName: true,
                      avatarUrl: true,
                      isOnline: true,
                      isVerified: true,
                      status: true,
                      availableFor: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      res.json(callLogs);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch call history');
      res.status(500).json({ message: 'Failed to fetch call history' });
    }
  }
);

export { router as callRouter };
