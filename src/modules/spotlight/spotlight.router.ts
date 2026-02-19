import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { getBlockedUserIds, buildBroadcasterList, areUsersBlocked } from './spotlight.service';
import { liveBroadcasters } from './spotlight.gateway';
import { generateSpotlightToken, LIVEKIT_URL } from './spotlight.livekit';

const router = Router();

// ─── GET /api/spotlight/live ─────────────────────────────────────────────────

router.get(
  '/live',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const blockedIds = await getBlockedUserIds(userId);
      const list = buildBroadcasterList(liveBroadcasters, userId, blockedIds);
      res.json({ broadcasters: list });
    } catch (error) {
      logger.error({ error }, 'Error listing live broadcasters');
      res.status(500).json({ error: 'Failed to list broadcasters' });
    }
  }
);

// ─── POST /api/spotlight/livekit-token ───────────────────────────────────────
//
// Body: { broadcasterId: string, role: 'broadcaster' | 'viewer' }
// Returns: { token: string, url: string }

router.post(
  '/livekit-token',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { broadcasterId, role } = req.body as { broadcasterId?: string; role?: string };

      if (!broadcasterId || typeof broadcasterId !== 'string') {
        return res.status(400).json({ error: 'broadcasterId required' });
      }
      if (role !== 'broadcaster' && role !== 'viewer') {
        return res.status(400).json({ error: 'role must be broadcaster or viewer' });
      }

      // Broadcaster can only create a token for themselves
      if (role === 'broadcaster' && broadcasterId !== userId) {
        return res.status(403).json({ error: 'Cannot broadcast as another user' });
      }

      // Viewer can only join an active broadcast
      if (role === 'viewer') {
        if (!liveBroadcasters.has(broadcasterId)) {
          return res.status(404).json({ error: 'Broadcaster not found or not live' });
        }
        const blocked = await areUsersBlocked(userId, broadcasterId);
        if (blocked) {
          return res.status(403).json({ error: 'Cannot view this broadcaster' });
        }
      }

      const token = await generateSpotlightToken(userId, broadcasterId, role);
      res.json({ token, url: LIVEKIT_URL });
    } catch (error) {
      logger.error({ error }, 'Error generating LiveKit token');
      res.status(500).json({ error: 'Failed to generate token' });
    }
  }
);

export { router as spotlightRouter };
