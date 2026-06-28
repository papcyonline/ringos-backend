import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { storyMediaUpload } from '../../shared/upload';
import { getLimits, isPro } from '../../shared/usage.service';
import {
  createStory,
  getStoryFeed,
  getUserStories,
  getDiscoverFeed,
  getFollowingFeed,
  markStoryViewed,
  markStorySlideViewed,
  getStoryViewers,
  getStorySlideViewers,
  likeStory,
  reactToStory,
  clearStoryReaction,
  replyToStory,
  muteUserStories,
  unmuteUserStories,
  hideStoryFromViewer,
  unhideStoryFromViewer,
  getHiddenViewers,
  updateSlideCaption,
  deleteStory,
  deleteSlide,
  bumpStoryShare,
  bumpStoryDownload,
  bumpStoryRepost,
} from './story.service';
import { createNotification, sendPostPush } from '../notification/notification.service';
import { checkStoryMilestone } from './story.notify';
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

// ─── GET /api/stories/user/:userId ──────────────────────────
// One user's active stories (feed-entry shape), so the client can open the
// story viewer for an arbitrary user (e.g. tapping a viewer's avatar).
router.get(
  '/user/:userId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const story = await getUserStories(
        req.params.userId as string,
        req.user!.userId,
      );
      if (!story) return res.status(404).json({ error: 'No active stories' });
      res.json({ story });
    } catch (error) {
      logger.error({ error }, 'Error fetching user stories');
      res.status(500).json({ error: 'Failed to fetch user stories' });
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

// ─── Hide my story from a viewer ────────────────────────────

// GET /api/stories/hidden — users I've hidden my story from
router.get(
  '/hidden',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const ownerId = req.user!.userId;
      const hidden = await getHiddenViewers(ownerId);
      res.json({ hidden });
    } catch (error) {
      logger.error({ error }, 'Error fetching hidden viewers');
      res.status(500).json({ error: 'Failed to fetch hidden viewers' });
    }
  }
);

// POST /api/stories/hide/:userId — hide my story from :userId
router.post(
  '/hide/:userId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const ownerId = req.user!.userId;
      const hiddenUserId = req.params.userId as string;
      await hideStoryFromViewer(ownerId, hiddenUserId);
      res.json({ success: true });
    } catch (error: any) {
      if (error?.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      logger.error({ error }, 'Error hiding story from user');
      res.status(500).json({ error: 'Failed to hide story' });
    }
  }
);

// DELETE /api/stories/hide/:userId — unhide (let them see my story again)
router.delete(
  '/hide/:userId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const ownerId = req.user!.userId;
      const hiddenUserId = req.params.userId as string;
      await unhideStoryFromViewer(ownerId, hiddenUserId);
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error unhiding story from user');
      res.status(500).json({ error: 'Failed to unhide story' });
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
  storyMediaUpload.fields([{ name: 'media', maxCount: 10 }, { name: 'thumbnails', maxCount: 10 }]),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const fieldFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
      const files = fieldFiles?.['media'] ?? [];

      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'At least one media file is required' });
      }

      // Parse slidesMetadata if provided (backward compat: treat all as IMAGE if missing)
      let slidesMetadata: Array<{
        type: 'IMAGE' | 'VIDEO' | 'TEXT';
        position: number;
        duration?: number;
        caption?: string;
        music?: Record<string, unknown>;
        videoEdits?: Record<string, unknown>;
      }> | undefined;
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
            error: `This file is too large — the limit is ${limits.storyUploadMB}MB. Try a shorter or lower-resolution video.`,
            code: 'FILE_TOO_LARGE',
            limitMB: limits.storyUploadMB,
          });
        }
      }

      const isPermanent = req.body.isPermanent === 'true' || req.body.isPermanent === true;
      const channelId = req.body.channelId as string | undefined;
      const visibility = (req.body.visibility as string | undefined) === 'PUBLIC'
          ? 'PUBLIC' as const
          : 'FRIENDS' as const;
      const thumbnailFiles = fieldFiles?.['thumbnails'];
      const story = await createStory(userId, files, slidesMetadata, {
        isPermanent,
        channelId,
        visibility,
        thumbnailFiles,
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

// ─── POST /api/stories/slides/:slideId/view ─────────────────
// Per-slide view (Instagram-style). Newer app builds call this per slide;
// older builds still hit POST /:id/view (story-level) above.

router.post(
  '/slides/:slideId/view',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const viewerId = req.user!.userId;
      const slideId = req.params.slideId as string;
      const stealth = req.body.stealth === true && await isPro(viewerId);
      await markStorySlideViewed(slideId, viewerId, stealth);
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error marking story slide viewed');
      res.status(500).json({ error: 'Failed to mark story slide viewed' });
    }
  }
);

// ─── GET /api/stories/slides/:slideId/viewers ───────────────

router.get(
  '/slides/:slideId/viewers',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.userId;
      const slideId = req.params.slideId as string;
      const viewers = await getStorySlideViewers(slideId, userId);

      if (viewers === null) {
        return res.status(403).json({ error: 'Not authorized to view slide viewers' });
      }

      res.json({ viewers });
    } catch (error) {
      logger.error({ error }, 'Error fetching story slide viewers');
      res.status(500).json({ error: 'Failed to fetch story slide viewers' });
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
        const likeTitle = liker.displayName;
        const likeBody = 'Liked your story';
        createNotification({
          userId: story.userId,
          type: 'STORY_LIKED',
          title: likeTitle,
          body: likeBody,
          imageUrl: liker.avatarUrl ?? undefined,
          data: { storyId, userId: viewerId, isVerified: liker.isVerified ?? false },
        }).catch((err) => {
          logger.error({ err, userId: story.userId }, 'Failed to send story like notification');
        });
        sendPostPush(story.userId, {
          title: likeTitle,
          body: likeBody,
          imageUrl: liker.avatarUrl ?? undefined,
          data: {
            type: 'STORY_LIKED',
            storyId,
            userId: viewerId,
            senderId: viewerId,
            senderName: likeTitle,
            senderAvatar: liker.avatarUrl ?? '',
          },
        }).catch((err) => {
          logger.error({ err, userId: story.userId }, 'Failed to send story-like push');
        });

        // Milestone check: read the denormalized likeCount on Story
        // (kept in sync by likeStory) and notify the owner if they
        // just crossed a tier. Fire-and-forget.
        (async () => {
          try {
            const fresh = await prisma.story.findUnique({
              where: { id: storyId },
              select: { likeCount: true },
            });
            if (fresh?.likeCount != null) {
              await checkStoryMilestone(storyId, story.userId, 'likes', fresh.likeCount);
            }
          } catch (err) {
            logger.warn({ err, storyId }, 'Failed to evaluate like milestone');
          }
        })();
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

      // Notify all connected clients so their feed providers can drop
      // the story from cache without waiting for the 60s polling tick.
      // We only fire when the whole story is gone — partial slide
      // deletions don't change the feed shape (the story still appears
      // with one fewer slide, refreshed via story:new on next poll).
      if (result.storyDeleted && result.storyId) {
        getIO().emit('story:deleted', { storyId: result.storyId, userId });
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
        const reactTitle = reactor.displayName;
        const reactBody = `Reacted ${emoji} to your story`;
        createNotification({
          userId: story.userId,
          type: 'STORY_LIKED',
          title: reactTitle,
          body: reactBody,
          imageUrl: reactor.avatarUrl ?? undefined,
          data: { storyId, userId, emoji, isVerified: reactor.isVerified ?? false },
        }).catch((err) => {
          logger.error({ err, userId: story.userId }, 'Failed to send story reaction notification');
        });
        sendPostPush(story.userId, {
          title: reactTitle,
          body: reactBody,
          imageUrl: reactor.avatarUrl ?? undefined,
          data: {
            type: 'STORY_LIKED',
            storyId,
            userId,
            emoji,
            senderId: userId,
            senderName: reactTitle,
            senderAvatar: reactor.avatarUrl ?? '',
          },
        }).catch((err) => {
          logger.error({ err, userId: story.userId }, 'Failed to send story-react push');
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

// ─── Engagement Counter Bumps ─────────────────────────────
// share / download / repost are fire-and-forget: the FE optimistically
// increments the count locally and posts here so the server number
// stays in sync with what other viewers see on next feed refresh.

router.post(
  '/:id/share',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const ok = await bumpStoryShare(req.params.id as string);
      if (!ok) return res.status(404).json({ error: 'Story not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/download',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const ok = await bumpStoryDownload(req.params.id as string);
      if (!ok) return res.status(404).json({ error: 'Story not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/repost',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const ok = await bumpStoryRepost(req.params.id as string);
      if (!ok) return res.status(404).json({ error: 'Story not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
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

      // Real-time fan-out so other clients drop the story from their
      // feed cache immediately. Mirrors the story:new event used on
      // creation. The user's own client also listens and reacts so a
      // single event handler keeps every cache in sync.
      getIO().emit('story:deleted', { storyId, userId });

      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Error deleting story');
      res.status(500).json({ error: 'Failed to delete story' });
    }
  }
);

export { router as storyRouter };
