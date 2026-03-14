import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { getIO } from '../../config/socket';
import { prisma } from '../../config/database';
import {
  getBalance,
  purchaseCoins,
  sendGift,
  GIFT_TYPES,
} from './coins.service';

const router = Router();

// ─── GET /api/coins/balance ──────────────────────────────

router.get(
  '/balance',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const balance = await getBalance(userId);
      res.json({ balance });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/coins/purchase ────────────────────────────

router.post(
  '/purchase',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { packId } = req.body as { packId: string };

      if (!packId) {
        return res.status(400).json({ error: 'packId is required' });
      }

      const result = await purchaseCoins(userId, packId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/coins/gift-types ───────────────────────────

router.get(
  '/gift-types',
  authenticate,
  async (_req: AuthRequest, res: Response) => {
    const types = Object.entries(GIFT_TYPES).map(([type, cost]) => ({
      type,
      cost,
    }));
    res.json({ giftTypes: types });
  }
);

// ─── POST /api/coins/gift ────────────────────────────────

router.post(
  '/gift',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const senderId = req.user!.userId;
      const { storyId, giftType } = req.body as { storyId: string; giftType: string };

      if (!storyId || !giftType) {
        return res.status(400).json({ error: 'storyId and giftType are required' });
      }

      const result = await sendGift(senderId, storyId, giftType);

      // Emit real-time gift event so story viewer can show animation
      try {
        const story = await prisma.story.findUnique({
          where: { id: storyId },
          select: { userId: true },
        });
        const sender = await prisma.user.findUnique({
          where: { id: senderId },
          select: { displayName: true, avatarUrl: true },
        });
        if (story && sender) {
          getIO().to(story.userId).emit('story:gift', {
            storyId,
            senderId,
            senderName: sender.displayName,
            senderAvatar: sender.avatarUrl,
            giftType,
            coinAmount: result.coinAmount,
          });
        }
      } catch {
        // Socket may not be available
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

export { router as coinsRouter };
