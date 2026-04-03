import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { storyMediaUpload } from '../../shared/upload';
import { getLimits, isPro } from '../../shared/usage.service';
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
import { createBoost, getBoostStatus } from './story-boost.service';
import { getStoryGiftStats } from '../coins/coins.service';
import { createNotification } from '../notification/notification.service';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';

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

      // Enforce file size limit based on Pro status
      const limits = await getLimits(userId);
      const maxBytes = limits.storyUploadMB * 1024 * 1024;
      for (const file of files) {
        if (file.size > maxBytes) {
          return res.status(413).json({
            error: `File exceeds ${limits.storyUploadMB}MB limit`,
            code: 'FILE_TOO_LARGE',
          });
        }
      }

      const isPermanent = req.body.isPermanent === 'true' || req.body.isPermanent === true;
      const story = await createStory(userId, files, slidesMetadata, { isPermanent });

      // Notify all connected users so their feed refreshes instantly
      try {
        getIO().emit('story:new', { userId, storyId: story.id });
      } catch {
        // Socket may not be initialized in tests
      }

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
      const stealth = req.body.stealth === true && await isPro(viewerId);
      await markStoryViewed(storyId, viewerId, stealth);
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
      const liked = req.body?.liked !== false; // default true, pass false to unlike
      await likeStory(storyId, viewerId, liked);

      // Send notification to the story owner (only on like, not unlike)
      if (!liked) { res.json({ success: true }); return; }
      const [story, liker] = await Promise.all([
        prisma.story.findUnique({ where: { id: storyId }, select: { userId: true } }),
        prisma.user.findUnique({ where: { id: viewerId }, select: { displayName: true, avatarUrl: true, isVerified: true } }),
      ]);

      if (story && liker && story.userId !== viewerId) {
        createNotification({
          userId: story.userId,
          type: 'STORY_LIKED',
          title: liker.displayName,
          body: 'Liked your story',
          imageUrl: liker.avatarUrl ?? undefined,
          data: { storyId, userId: viewerId, isVerified: liker.isVerified ?? false },
        }).catch((err) => {
          logger.error({ err, userId: story.userId }, 'Failed to send story like notification');
        });
      }

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

// ─── POST /api/stories/:id/boost ─────────────────────────

router.post(
  '/:id/boost',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const storyId = req.params.id as string;
      const { tier } = req.body as { tier?: string };

      const boost = await createBoost(storyId, userId, tier);
      res.json({ boost });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/stories/:id/boost-status ───────────────────

router.get(
  '/:id/boost-status',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const storyId = req.params.id as string;
      // Verify the requester owns this story
      const story = await prisma.story.findUnique({ where: { id: storyId }, select: { userId: true } });
      if (!story) return res.status(404).json({ error: 'Story not found' });
      if (story.userId !== req.user!.userId) return res.status(403).json({ error: 'Not your story' });
      const status = await getBoostStatus(storyId);
      res.json(status);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/stories/:id/gift-stats ─────────────────────

router.get(
  '/:id/gift-stats',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const storyId = req.params.id as string;
      const stats = await getStoryGiftStats(storyId);
      res.json(stats);
    } catch (err) {
      next(err);
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
