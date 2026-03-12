import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { storyMediaUpload } from '../../shared/upload';
import {
  createStory,
  getStoryFeed,
  markStoryViewed,
  getStoryViewers,
  likeStory,
  updateSlideCaption,
  deleteStory,
  deleteSlide,
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
  storyMediaUpload.array('media', 10),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'At least one media file is required' });
      }

      // Parse slidesMetadata if provided (backward compat: treat all as IMAGE if missing)
      let slidesMetadata: Array<{ type: 'IMAGE' | 'VIDEO' | 'TEXT'; position: number; duration?: number }> | undefined;
      if (req.body.slidesMetadata) {
        try {
          slidesMetadata = JSON.parse(req.body.slidesMetadata);
        } catch {
          return res.status(400).json({ error: 'Invalid slidesMetadata JSON' });
        }

        // Validate slidesMetadata length matches files
        if (slidesMetadata && slidesMetadata.length !== files.length) {
          return res.status(400).json({
            error: `slidesMetadata length (${slidesMetadata.length}) must match number of files (${files.length})`,
          });
        }
      }

      const story = await createStory(userId, files, slidesMetadata);
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

// ─── POST /api/stories/:id/like ──────────────────────────────

router.post(
  '/:id/like',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const viewerId = req.user!.userId;
      const storyId = req.params.id as string;
      await likeStory(storyId, viewerId);
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error liking story');
      res.status(500).json({ error: 'Failed to like story' });
    }
  }
);

// ─── PATCH /api/stories/slides/:slideId/caption ─────────────

router.patch(
  '/slides/:slideId/caption',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const slideId = req.params.slideId as string;
      const { caption } = req.body as { caption?: string };
      const result = await updateSlideCaption(slideId, userId, caption ?? null);

      if (!result.updated) {
        const status = result.reason === 'not_found' ? 404 : 403;
        return res.status(status).json({
          error: result.reason === 'not_found' ? 'Slide not found' : 'Not authorized',
        });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error updating slide caption');
      res.status(500).json({ error: 'Failed to update caption' });
    }
  }
);

// ─── DELETE /api/stories/slides/:slideId ────────────────────

router.delete(
  '/slides/:slideId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const slideId = req.params.slideId as string;
      const result = await deleteSlide(slideId, userId);

      if (!result.deleted) {
        const status = result.reason === 'not_found' ? 404 : 403;
        return res.status(status).json({
          error: result.reason === 'not_found' ? 'Slide not found' : 'Not authorized',
        });
      }

      res.json({ success: true, storyDeleted: result.storyDeleted });
    } catch (error) {
      logger.error({ error }, 'Error deleting slide');
      res.status(500).json({ error: 'Failed to delete slide' });
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
