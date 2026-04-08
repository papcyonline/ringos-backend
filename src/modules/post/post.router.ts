import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { postMediaUpload, fileToPostImageUrl, fileToPostVideoUrl } from '../../shared/upload';
import * as postService from './post.service';

const router = Router();

// GET /posts/feed — Get updates feed (posts from subscribed channels)
router.get('/feed', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = (req.query.cursor as string) || undefined;
    const limit = parseInt(req.query.limit as string || '20') || 20;
    const result = await postService.getFeed(req.user!.userId, cursor, limit);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /posts/discover — Discover posts from public channels
router.get('/discover', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = (req.query.cursor as string) || undefined;
    const limit = parseInt(req.query.limit as string || '20') || 20;
    const result = await postService.discoverPosts(req.user!.userId, cursor, limit);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /posts/channel/:channelId — Get posts for a specific channel
router.get('/channel/:channelId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = (req.query.cursor as string) || undefined;
    const limit = parseInt(req.query.limit as string || '20') || 20;
    const result = await postService.getChannelPosts(req.params.channelId as string, req.user!.userId, cursor, limit);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts — Create a post (with optional multi-media upload)
router.post(
  '/',
  authenticate,
  (req: AuthRequest, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      postMediaUpload.array('media', 10)(req, res, next);
    } else {
      next();
    }
  },
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { channelId, content } = req.body;
      if (!channelId) return res.status(400).json({ error: 'channelId is required' });

      const files = (req.files as Express.Multer.File[]) || [];

      // Upload all files in parallel
      const media = await Promise.all(files.map(async (file, i) => {
        const isVideo = file.mimetype.startsWith('video/');
        if (isVideo) {
          const result = await fileToPostVideoUrl(file, req.user!.userId);
          return { url: result.secureUrl, type: 'VIDEO' as const, thumbnailUrl: result.thumbnailUrl ?? undefined, cloudinaryId: result.publicId, position: i };
        }
        const result = await fileToPostImageUrl(file, req.user!.userId);
        return { url: result.secureUrl, type: 'IMAGE' as const, cloudinaryId: result.publicId, position: i };
      }));

      // Support legacy single mediaUrl in body (no file upload)
      let mediaUrl: string | undefined;
      let mediaType: string | undefined;
      if (files.length === 0 && req.body.mediaUrl) {
        mediaUrl = req.body.mediaUrl;
        mediaType = req.body.mediaType || 'image';
      }

      const post = await postService.createPost(
        channelId,
        req.user!.userId,
        content || '',
        mediaUrl,
        mediaType,
        req.body.thumbnailUrl,
        media.length > 0 ? media : undefined,
        {
          locationName: req.body.locationName || undefined,
          taggedUserIds: req.body.taggedUserIds ? JSON.parse(req.body.taggedUserIds) : undefined,
          musicTitle: req.body.musicTitle || undefined,
          musicArtist: req.body.musicArtist || undefined,
          commentsDisabled: req.body.commentsDisabled === 'true',
          hideLikeCount: req.body.hideLikeCount === 'true',
          scheduledAt: req.body.scheduledAt || undefined,
        },
      );
      res.status(201).json(post);
    } catch (err) { next(err); }
  },
);

// GET /posts/trending-hashtags — Get trending hashtags
router.get('/trending-hashtags', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit as string, 10) || 10);
    const hashtags = await postService.getTrendingHashtags(limit);
    res.json({ hashtags });
  } catch (err) { next(err); }
});

// GET /posts/hashtag/:tag — Search posts by hashtag
router.get('/hashtag/:tag', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(50, parseInt(req.query.limit as string, 10) || 20);
    const result = await postService.searchByHashtag(req.params.tag as string, req.user!.userId, cursor, limit);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /posts/bookmarks — Get user's bookmarked posts
router.get('/bookmarks', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(50, parseInt(req.query.limit as string, 10) || 20);
    const result = await postService.getBookmarkedPosts(req.user!.userId, cursor, limit);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /posts/scheduled/:channelId — Get scheduled posts for a channel (admin only)
router.get('/scheduled/:channelId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const posts = await postService.getScheduledPosts(req.params.channelId as string, req.user!.userId);
    res.json({ posts });
  } catch (err) { next(err); }
});

// DELETE /posts/scheduled/:postId — Delete a scheduled post (admin only)
router.delete('/scheduled/:postId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.deleteScheduledPost(req.params.postId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/:postId/react — Toggle reaction on a post
router.post('/:postId/react', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { emoji } = req.body;
    if (!emoji || typeof emoji !== 'string') return res.status(400).json({ error: 'emoji is required' });
    const result = await postService.toggleReaction(req.params.postId as string, req.user!.userId, emoji);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/:postId/like — Toggle like on a post
router.post('/:postId/like', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.toggleLike(req.params.postId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/:postId/bookmark — Toggle bookmark on a post
router.post('/:postId/bookmark', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.toggleBookmark(req.params.postId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/:postId/comments — Add a comment (or reply)
router.post('/:postId/comments', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { content, parentId } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'content is required' });
    const comment = await postService.addComment(req.params.postId as string, req.user!.userId, content.trim(), parentId);
    res.status(201).json(comment);
  } catch (err) { next(err); }
});

// GET /posts/:postId/comments — Get comments for a post
router.get('/:postId/comments', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cursor = (req.query.cursor as string) || undefined;
    const result = await postService.getComments(req.params.postId as string, req.user!.userId, cursor);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/comments/:commentId/like — Toggle like on a comment
router.post('/comments/:commentId/like', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.toggleCommentLike(req.params.commentId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/bulk-delete — Bulk delete posts (admin only)
router.post('/bulk-delete', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { postIds } = req.body;
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: 'postIds array is required' });
    }
    const result = await postService.bulkDeletePosts(postIds, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /posts/:postId — Delete a post
router.delete('/:postId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.deletePost(req.params.postId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/:postId/pin — Pin/unpin post on channel
router.post('/:postId/pin', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.togglePinPost(req.params.postId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// PATCH /posts/:postId/caption — Edit post caption
router.patch('/:postId/caption', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { content } = req.body;
    const result = await postService.editCaption(req.params.postId as string, req.user!.userId, content ?? '');
    res.json(result);
  } catch (err) { next(err); }
});

// POST /posts/:postId/view — Track post view
router.post('/:postId/view', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await postService.trackView(req.params.postId as string);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /posts/analytics/:channelId — Channel analytics
router.get('/analytics/:channelId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await postService.getChannelAnalytics(req.params.channelId as string, req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

export { router as postRouter };
