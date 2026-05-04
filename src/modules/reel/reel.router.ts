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
  repostReel,
  unrepostReel,
  markReelViewed,
  deleteReel,
  addReelComment,
  getReelComments,
  deleteReelComment,
  countReelsCreatedSince,
  reactToReel,
  clearReelReaction,
} from './reel.service';
import { getReelStats } from './reel.stats.service';

const MAX_REELS_PER_HOUR = 10;

const router = Router();

// ─── GET /api/reels/feed ────────────────────────────────────

router.get('/feed', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt((req.query.limit as string) || '10', 10);
    const audienceQ = req.query.audience as string | undefined;
    const audience: 'all' | 'following' | 'mine' = audienceQ === 'following'
      ? 'following'
      : audienceQ === 'mine'
        ? 'mine'
        : 'all';
    const data = await getReelFeed(
      userId,
      cursor,
      Math.min(Math.max(limit, 1), 30),
      audience,
    );
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
      // Rate limit: cap reel uploads per user per hour.
      const oneHourAgo = new Date(Date.now() - 3600 * 1000);
      const recentCount = await countReelsCreatedSince(userId, oneHourAgo);
      if (recentCount >= MAX_REELS_PER_HOUR) {
        return res.status(429).json({
          error: `Rate limit reached — max ${MAX_REELS_PER_HOUR} reels per hour`,
          code: 'RATE_LIMITED',
        });
      }
      const caption = (req.body.caption as string | undefined)?.trim();
      const musicTitle = (req.body.musicTitle as string | undefined)?.trim();
      const musicPreviewUrl = (req.body.musicPreviewUrl as string | undefined)?.trim();
      const musicArtist = (req.body.musicArtist as string | undefined)?.trim();
      const musicArtwork = (req.body.musicArtwork as string | undefined)?.trim();
      // Mix levels (0..1) — multipart strings, parsed defensively. Out-of-
      // range values are clamped so a buggy client can't poison the row.
      const parseVolume = (raw: unknown): number | undefined => {
        if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
        const n = parseFloat(raw);
        if (Number.isNaN(n)) return undefined;
        return Math.max(0, Math.min(1, n));
      };
      const videoVolume = parseVolume(req.body.videoVolume);
      const musicVolume = parseVolume(req.body.musicVolume);
      const durationStr = req.body.durationSec as string | undefined;
      const durationSec = durationStr ? parseInt(durationStr, 10) : undefined;
      // Viewer-side video edits ride along as a JSON-encoded multipart field
      // (matches stories' slidesMetadata pattern). Reject malformed JSON
      // outright — silently dropping would post a video without the user's
      // edits, which is exactly the bug we just fixed for stories.
      let videoEdits: Record<string, unknown> | undefined;
      const editsRaw = req.body.videoEdits as string | undefined;
      if (editsRaw && editsRaw.trim().length > 0) {
        try {
          const parsed = JSON.parse(editsRaw);
          if (parsed && typeof parsed === 'object') {
            videoEdits = parsed as Record<string, unknown>;
          }
        } catch {
          return res
            .status(400)
            .json({ error: 'videoEdits must be valid JSON' });
        }
      }
      const reel = await createReel(userId, file, {
        caption,
        musicTitle,
        musicPreviewUrl,
        musicArtist,
        musicArtwork,
        videoVolume,
        musicVolume,
        durationSec,
        videoEdits,
      });
      res.json({ reel });
    } catch (error: any) {
      if (error?.statusCode === 400) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
        });
      }
      logger.error({ error, stack: error?.stack, name: error?.name }, 'Error creating reel');
      res.status(500).json({
        error: error?.message || 'Failed to create reel',
        name: error?.name,
        code: error?.code,
      });
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

// ─── POST /api/reels/:id/react ──────────────────────────────
// Body: { emoji }. Emoji must be in the shared ALLOWED_REACTION_EMOJIS
// allow-list. Upsert semantics — re-tapping replaces the prior emoji.

router.post('/:id/react', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const emoji = (req.body?.emoji ?? '') as string;
    const result = await reactToReel(req.params.id as string, req.user!.userId, emoji);
    if (!result) return res.status(404).json({ error: 'Reel not found' });
    res.json({ success: true, emoji: result.emoji });
  } catch (error: any) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ error }, 'Error reacting to reel');
    res.status(500).json({ error: 'Failed to react' });
  }
});

// ─── DELETE /api/reels/:id/react ────────────────────────────

router.delete('/:id/react', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await clearReelReaction(req.params.id as string, req.user!.userId);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Error clearing reel reaction');
    res.status(500).json({ error: 'Failed to clear reaction' });
  }
});

// ─── POST /api/reels/:id/repost ─────────────────────────────

router.post('/:id/repost', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await repostReel(req.params.id as string, req.user!.userId);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Error reposting reel');
    res.status(500).json({ error: 'Failed to repost' });
  }
});

// ─── DELETE /api/reels/:id/repost ───────────────────────────

router.delete('/:id/repost', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await unrepostReel(req.params.id as string, req.user!.userId);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Error un-reposting reel');
    res.status(500).json({ error: 'Failed to un-repost' });
  }
});

// ─── POST /api/reels/:id/view ───────────────────────────────

router.post('/:id/view', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const watchedSec = Number(req.body?.watchedSec);
    const completed = req.body?.completed === true;
    await markReelViewed(req.params.id as string, req.user!.userId, {
      watchedSec: Number.isFinite(watchedSec) ? watchedSec : undefined,
      completed,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark viewed' });
  }
});

// ─── GET /api/reels/:id/stats ───────────────────────────────

router.get('/:id/stats', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const stats = await getReelStats(req.params.id as string, req.user!.userId);
    res.json({ stats });
  } catch (error: any) {
    if (error?.statusCode === 403) {
      return res.status(403).json({ error: error.message });
    }
    if (error?.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }
    logger.error({ error }, 'Error fetching reel stats');
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── GET /api/reels/:id/comments ────────────────────────────

router.get('/:id/comments', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt((req.query.limit as string) || '30', 10);
    const data = await getReelComments(
      req.params.id as string,
      cursor,
      Math.min(Math.max(limit, 1), 50),
    );
    res.json(data);
  } catch (error) {
    logger.error({ error }, 'Error fetching reel comments');
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ─── POST /api/reels/:id/comments ───────────────────────────

router.post('/:id/comments', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const content = (req.body?.content as string | undefined) ?? '';
    const comment = await addReelComment(req.params.id as string, userId, content);
    res.json({ comment });
  } catch (error: any) {
    if (error?.statusCode === 400 || error?.statusCode === 404) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error({ error }, 'Error creating comment');
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// ─── DELETE /api/reels/comments/:commentId ──────────────────

router.delete(
  '/comments/:commentId',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      await deleteReelComment(
        req.params.commentId as string,
        req.user!.userId,
      );
      res.json({ success: true });
    } catch (error: any) {
      if (error?.statusCode === 403 || error?.statusCode === 404) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      logger.error({ error }, 'Error deleting comment');
      res.status(500).json({ error: 'Failed to delete comment' });
    }
  },
);

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
