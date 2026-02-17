import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { getBlockedUserIds, buildBroadcasterList } from './spotlight.service';
import { liveBroadcasters } from './spotlight.gateway';

const router = Router();

// ─── GET /api/spotlight/live — HTTP fallback to list live broadcasters ───────

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

export { router as spotlightRouter };
