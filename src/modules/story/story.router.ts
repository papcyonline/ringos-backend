import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { storyMediaUpload } from '../../shared/upload';
import { getLimits, isPro } from '../../shared/usage.service';
import {
  createStory,
  getStoryFeed,
  getDiscoverFeed,
  getFollowingFeed,
  markStoryViewed,
  getStoryViewers,
  likeStory,
  reactToStory,
  clearStoryReaction,
  replyToStory,
  muteUserStories,
  unmuteUserStories,
  updateSlideCaption,
  deleteStory,
  deleteSlide,
} from './story.service';
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

// ─── GET /api/stories/discover ──────────────────────────────

router.get(
  '/discover',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const feed = await getDiscoverFeed(userId);
      res.json({ feed });
    } catch (error) {
      logger.error({ error }, 'Error fetching discover feed');
      res.status(500).json({ error: 'Failed to fetch discover feed' });
    }
  }
);

// ─── POST /api/stories/mute/:userId ─────────────────────────

router.post(
  '/mute/:userId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const muterId = req.user!.userId;
      const mutedUserId = req.params.userId as string;
      await muteUserStories(muterId, mutedUserId);
      res.json({ success: true });
    } catch (error: any) {
      if (error?.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      logger.error({ error }, 'Error muting user stories');
      res.status(500).json({ error: 'Failed to mute user' });
    }
  }
);

// ─── DELETE /api/stories/mute/:userId ───────────────────────

router.delete(
  '/mute/:userId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const muterId = req.user!.userId;
      const mutedUserId = req.params.userId as string;
      await unmuteUserStories(muterId, mutedUserId);
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error unmuting user stories');
      res.status(500).json({ error: 'Failed to unmute user' });
    }
  }
);

// ─── GET /api/stories/following ─────────────────────────────

router.get(
  '/following',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const feed = await getFollowingFeed(userId);
      res.json({ feed });
    } catch (error) {
      logger.error({ error }, 'Error fetching following feed');
      res.status(500).json({ error: 'Failed to fetch following feed' });
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
      const channelId = req.body.channelId as string | undefined;
      const visibility = (req.body.visibility as string | undefined) === 'PUBLIC'
          ? 'PUBLIC' as const
          : 'FRIENDS' as const;
      const story = await createStory(userId, files, slidesMetadata, {
        isPermanent,
        channelId,
        visibility,
      });

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

// ─── POST /api/stories/:id/react ─────────────────────────

router.post(
  '/:id/react',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const storyId = req.params.id as string;
      const emoji = (req.body?.emoji as string | undefined)?.trim();

      if (!emoji) {
        return res.status(400).json({ error: 'emoji is required' });
      }

      const result = await reactToStory(storyId, userId, emoji);
      if (!result) return res.status(404).json({ error: 'Story not found' });

      // Notify the story owner (skip if reacting to own story)
      const [story, reactor] = await Promise.all([
        prisma.story.findUnique({ where: { id: storyId }, select: { userId: true } }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true, avatarUrl: true, isVerified: true },
        }),
      ]);

      if (story && reactor && story.userId !== userId) {
        createNotification({
          userId: story.userId,
          type: 'STORY_LIKED',
          title: reactor.displayName,
          body: `Reacted ${emoji} to your story`,
          imageUrl: reactor.avatarUrl ?? undefined,
          data: { storyId, userId, emoji, isVerified: reactor.isVerified ?? false },
        }).catch((err) => {
          logger.error({ err, userId: story.userId }, 'Failed to send story reaction notification');
        });
      }

      res.json({ success: true, emoji: result.emoji });
    } catch (error: any) {
      if (error?.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      logger.error({ error }, 'Error reacting to story');
      res.status(500).json({ error: 'Failed to react to story' });
    }
  }
);

// ─── DELETE /api/stories/:id/react ───────────────────────

router.delete(
  '/:id/react',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const storyId = req.params.id as string;
      await clearStoryReaction(storyId, userId);
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error clearing story reaction');
      res.status(500).json({ error: 'Failed to clear reaction' });
    }
  }
);

// ─── POST /api/stories/:id/reply ─────────────────────────

router.post(
  '/:id/reply',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const senderId = req.user!.userId;
      const storyId = req.params.id as string;
      const text = (req.body?.text as string | undefined) ?? '';

      const result = await replyToStory(storyId, senderId, text);
      if (!result) return res.status(404).json({ error: 'Story not found' });

      res.json({ success: true, ...result });
    } catch (error: any) {
      if (error?.statusCode === 400 || error?.statusCode === 403) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      logger.error({ error }, 'Error replying to story');
      res.status(500).json({ error: 'Failed to reply to story' });
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
