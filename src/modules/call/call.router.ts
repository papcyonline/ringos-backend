import { Router, Response } from 'express';
import twilio from 'twilio';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { prisma } from '../../config/database';
import { answerCall } from './call.gateway';
import { getIO } from '../../config/socket';

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
//
// Query params:
//   forceRelay=1|true — response includes iceTransportPolicy:'relay' so the
//     client forces all traffic through TURN. Use for users on restrictive
//     networks (some Gulf states, enterprise VPNs, carrier DPI) where direct
//     P2P is blocked. Costs more TURN bandwidth but guarantees reachability.
//
// For TRULY global reach, env TURN should include a turns:host:443?transport=tcp
// variant (TLS on 443) alongside the regular UDP/TCP entries — that variant
// survives almost any DPI / firewall / VPN.

router.get(
  '/ice-servers',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    const forceRelay = req.query.forceRelay === '1' || req.query.forceRelay === 'true';
    const transportPolicy = forceRelay ? 'relay' : 'all';

    // 1. Custom TURN servers from env vars (highest priority)
    if (isTurnConfigured) {
      const servers = [...STUN_SERVERS, ...buildEnvTurnServers()];
      logger.info({ count: servers.length, forceRelay }, 'Returning env-configured TURN + STUN servers');
      res.json({ iceServers: servers, iceTransportPolicy: transportPolicy });
      return;
    }

    // 2. Twilio NTS (ephemeral TURN credentials)
    if (isTwilioConfigured) {
      try {
        const client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
        const token = await client.tokens.create();
        logger.info({ forceRelay }, 'Returning Twilio NTS ICE servers');
        res.json({ iceServers: token.iceServers, iceTransportPolicy: transportPolicy });
        return;
      } catch (err) {
        logger.error({ err }, 'Twilio NTS failed — falling back to STUN-only');
      }
    }

    // 3. STUN-only fallback (will NOT work across different networks).
    // forceRelay is meaningless here — no TURN to relay through.
    logger.warn('No TURN servers configured — calls will only work on the same network');
    res.json({ iceServers: STUN_SERVERS, iceTransportPolicy: 'all' });
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

// ─── Post-call quality rating ────────────────────────────────────────────────
// Users rate their own call (answered calls only). Only participants of the
// call's conversation may submit a rating; one row per call stores the
// caller's perceived quality + optional issue tags.

router.post(
  '/:callId/rating',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const callId = req.params.callId as string;
      const rating = Number(req.body?.rating);
      const issuesInput = req.body?.issues;
      const issues = Array.isArray(issuesInput)
        ? issuesInput.filter((x: unknown): x is string => typeof x === 'string' && x.length <= 40).slice(0, 10)
        : [];

      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ message: 'rating must be an integer 1-5' });
      }

      const call = await prisma.callLog.findUnique({
        where: { callId },
        select: { id: true, conversationId: true, status: true },
      });
      if (!call) return res.status(404).json({ message: 'Call not found' });
      if (call.status !== 'COMPLETED') {
        return res.status(400).json({ message: 'Only completed calls can be rated' });
      }

      // Caller must be a participant in the conversation.
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: call.conversationId, userId } },
        select: { leftAt: true },
      });
      if (!participant) return res.status(403).json({ message: 'Not a participant' });

      const updated = await prisma.callLog.update({
        where: { callId },
        data: { qualityRating: rating, qualityIssues: issues },
        select: { callId: true, qualityRating: true, qualityIssues: true },
      });
      res.json(updated);
    } catch (err) {
      logger.error({ err }, 'Failed to save call quality rating');
      res.status(500).json({ message: 'Failed to save rating' });
    }
  }
);

// ─── Answer call (REST) ──────────────────────────────────────────────────
//
// Mirror of the `call:answer` socket handler. Exists because socket-based
// answer is unreliable on iOS cold-launch slide-to-answer: the Flutter
// SocketClient's `_socket` is null while keychain-backed `getToken()`
// resolves (1-4s on a freshly-killed app), and `_socket?.emit(...)` in
// that window is silently dropped. HTTP doesn't depend on a long-lived
// socket and has a real status code on failure, so this is the
// authoritative accept path. Frontend fires this immediately on accept
// and uses the returned LiveKit token to connect to the room directly.
router.post(
  '/:callId/answer',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const callId = req.params.callId as string;
      if (!callId) return res.status(400).json({ message: 'callId required' });

      // Optional: caller's own VoIP token, so backend's cancel-push to
      // siblings doesn't loop back to this device. Without this, CallKit
      // shows "Declined" on the lock screen (the call actually connects,
      // but the cancel-push triggers a show+end on the answerer's CallKit
      // which iOS displays as a declined call).
      const excludeVoipToken = typeof req.body?.voipToken === 'string'
        ? req.body.voipToken
        : undefined;

      // Refresh / register this voipToken AND prune stale rows for the same
      // user BEFORE answerCall fires the sibling cancel-push. Two cold-launch
      // races we close here:
      //   1. Flutter's auth-provider registers the voipToken async; on a
      //      slide-to-answer from killed state the /answer POST can land
      //      before that registration completes. Without an entry in DB,
      //      the `token: { not: excludeVoipToken }` filter in
      //      sendCallCancelPush excludes nothing → cancel push goes to the
      //      most-recent (often stale) token → iOS shows "Declined".
      //   2. Reinstalls leave behind stale voipToken rows for the same
      //      physical device. Pruning rows older than 7 days keeps the
      //      sibling-cancel scope to genuinely-different active devices.
      // Both run before answerCall so the cancel-push query sees the right
      // set of tokens. Wrapped in try/catch — token bookkeeping must never
      // block an answer.
      if (excludeVoipToken && excludeVoipToken.length > 0) {
        try {
          const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          // Anti-hijack: only create the token if unowned, or refresh it if
          // it's already ours. NEVER reassign a token registered to a
          // DIFFERENT user — the old upsert (update: { userId }) let any
          // authenticated caller POST a victim's token value and steal that
          // row, hijacking the victim's incoming-call delivery. Genuine
          // device re-login reassignment is handled by the dedicated
          // /notifications/voip-token endpoint, not this defensive refresh.
          const existing = await prisma.voipToken.findUnique({
            where: { token: excludeVoipToken },
            select: { userId: true },
          });
          if (!existing) {
            await prisma.voipToken.create({
              data: { userId, token: excludeVoipToken, platform: 'ios' },
            });
          } else if (existing.userId === userId) {
            await prisma.voipToken.update({
              where: { token: excludeVoipToken },
              data: { createdAt: new Date() },
            });
          } else {
            logger.warn({ userId, callId },
              'Answer voipToken refresh skipped: token registered to another user');
          }
          // Prune only OUR OWN stale tokens (scoped by userId — can't touch
          // another user's rows).
          await prisma.voipToken.deleteMany({
            where: {
              userId,
              token: { not: excludeVoipToken },
              createdAt: { lt: cutoff },
            },
          });
        } catch (err) {
          logger.error({ err, userId, callId }, 'Failed to refresh voipToken on answer (continuing)');
        }
      }

      const result = await answerCall(getIO(), userId, callId, { excludeVoipToken });
      if (!result.ok) {
        const status = result.code === 'CALL_NOT_FOUND' ? 404
                     : result.code === 'ALREADY_ANSWERED' ? 409
                     : 500;
        return res.status(status).json({ code: result.code, message: result.message });
      }
      res.json({
        callId,
        livekitToken: result.livekitToken,
        livekitUrl: result.livekitUrl,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to answer call via REST');
      res.status(500).json({ message: 'Failed to answer call' });
    }
  }
);

export { router as callRouter };
