import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { storyMediaUpload } from '../../shared/upload';
import {
  createReel,
  getReelFeed,
  likeReel,
  unlikeReel,
  markReelViewed,
  deleteReel,
} from './reel.service';

const router = Router();

// ─── GET /api/reels/feed ────────────────────────────────────

router.get('/feed', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt((req.query.limit as string) || '10', 10);
    const data = await getReelFeed(userId, cursor, Math.min(Math.max(limit, 1), 30));
    res.json(data);
  } catch (error) {
    logger.error({ error }, 'Error fetching reel feed');
    res.status(500).json({ error: 'Failed to fetch reel feed' });
  }
});

// ─── POST /api/reels ────────────────────────────────────────

router.post(
  '/',
  authenticate,
  storyMediaUpload.single('video'),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: 'video file is required' });
      }
      const caption = (req.body.caption as string | undefined)?.trim();
      const musicTitle = (req.body.musicTitle as string | undefined)?.trim();
      const durationStr = req.body.durationSec as string | undefined;
      const durationSec = durationStr ? parseInt(durationStr, 10) : undefined;
      const reel = await createReel(userId, file, { caption, musicTitle, durationSec });
      res.json({ reel });
    } catch (error: any) {
      if (error?.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      logger.error({ error }, 'Error creating reel');
      res.status(500).json({ error: 'Failed to create reel' });
    }
  },
);

// ─── POST /api/reels/:id/like ───────────────────────────────

router.post('/:id/like', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await likeReel(req.params.id as string, req.user!.userId);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Error liking reel');
    res.status(500).json({ error: 'Failed to like reel' });
  }
});

// ─── DELETE /api/reels/:id/like ─────────────────────────────

router.delete('/:id/like', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await unlikeReel(req.params.id as string, req.user!.userId);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Error unliking reel');
    res.status(500).json({ error: 'Failed to unlike reel' });
  }
});

// ─── POST /api/reels/:id/view ───────────────────────────────

router.post('/:id/view', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await markReelViewed(req.params.id as string);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark viewed' });
  }
});

// ─── DELETE /api/reels/:id ──────────────────────────────────

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await deleteReel(req.params.id as string, req.user!.userId);
    res.json({ success: true });
  } catch (error: any) {
    if (error?.statusCode === 403) {
      return res.status(403).json({ error: error.message });
    }
    if (error?.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }
    logger.error({ error }, 'Error deleting reel');
    res.status(500).json({ error: 'Failed to delete reel' });
  }
});

export { router as reelRouter };
