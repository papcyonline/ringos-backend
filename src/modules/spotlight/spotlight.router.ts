import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { prisma } from '../../config/database';
import { liveBroadcasters } from './spotlight.gateway';
import { userCallMap } from '../call/call.gateway';

const router = Router();

// ─── GET /api/spotlight/live — HTTP fallback to list live broadcasters ───────

router.get(
  '/live',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;

    // Fetch blocks
    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedIds = new Set<string>();
    for (const b of blocks) {
      blockedIds.add(b.blockerId === userId ? b.blockedId : b.blockerId);
    }

    const list = Array.from(liveBroadcasters.entries())
      .filter(([id]) => id !== userId && !blockedIds.has(id) && !userCallMap.has(id))
      .map(([id, entry]) => ({
        userId: id,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl,
        bio: entry.bio,
        note: entry.note,
        viewerCount: entry.viewerIds.size,
        startedAt: entry.startedAt.toISOString(),
      }));

    res.json({ broadcasters: list });
  }
);

export { router as spotlightRouter };
