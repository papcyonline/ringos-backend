import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { getBlockedUserIds, buildBroadcasterList } from './spotlight.service';
import { liveBroadcasters } from './spotlight.gateway';

const router = Router();

// ─── GET /api/spotlight/live — HTTP fallback to list live broadcasters ───────

router.get(
  '/live',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;

    const blockedIds = await getBlockedUserIds(userId);
    const list = buildBroadcasterList(liveBroadcasters, userId, blockedIds);

    res.json({ broadcasters: list });
  }
);

export { router as spotlightRouter };
