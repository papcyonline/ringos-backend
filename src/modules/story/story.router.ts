import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { storyImageUpload } from '../../shared/upload';
import {
  createStory,
  getStoryFeed,
  markStoryViewed,
  getStoryViewers,
  deleteStory,
} from './story.service';

const router = Router();

// ─── GET /api/stories/feed ──────────────────────────────────

router.get(
  '/feed',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const feed = await getStoryFeed(userId);
      res.json({ feed });
    } catch (error) {
      logger.error({ error }, 'Error fetching story feed');
      res.status(500).json({ error: 'Failed to fetch story feed' });
    }
  }
);

// ─── POST /api/stories ──────────────────────────────────────

router.post(
  '/',
  authenticate,
  storyImageUpload.array('images', 10),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'At least one image is required' });
      }

      const story = await createStory(userId, files);
      res.json({ story });
    } catch (error) {
      logger.error({ error }, 'Error creating story');
      res.status(500).json({ error: 'Failed to create story' });
    }
  }
);

// ─── POST /api/stories/:id/view ─────────────────────────────

router.post(
  '/:id/view',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const viewerId = req.user!.userId;
      const storyId = req.params.id as string;
      await markStoryViewed(storyId, viewerId);
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error marking story viewed');
      res.status(500).json({ error: 'Failed to mark story viewed' });
    }
  }
);

// ─── GET /api/stories/:id/viewers ───────────────────────────

router.get(
  '/:id/viewers',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const storyId = req.params.id as string;
      const viewers = await getStoryViewers(storyId, userId);

      if (viewers === null) {
        return res.status(403).json({ error: 'Not authorized to view story viewers' });
      }

      res.json({ viewers });
    } catch (error) {
      logger.error({ error }, 'Error fetching story viewers');
      res.status(500).json({ error: 'Failed to fetch story viewers' });
    }
  }
);

// ─── DELETE /api/stories/:id ────────────────────────────────

router.delete(
  '/:id',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const storyId = req.params.id as string;
      const result = await deleteStory(storyId, userId);

      if (!result.deleted) {
        const status = result.reason === 'not_found' ? 404 : 403;
        return res.status(status).json({ error: result.reason === 'not_found' ? 'Story not found' : 'Not authorized' });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error deleting story');
      res.status(500).json({ error: 'Failed to delete story' });
    }
  }
);

export { router as storyRouter };
