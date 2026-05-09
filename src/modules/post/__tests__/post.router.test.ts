import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockPostService } = vi.hoisted(() => ({
  mockPostService: {
    getPost: vi.fn().mockResolvedValue({ id: 'p-1' }),
    createPost: vi.fn().mockResolvedValue({ id: 'p-1' }),
    getFeed: vi.fn().mockResolvedValue({ posts: [], hasMore: false }),
    getChannelPosts: vi.fn().mockResolvedValue({ posts: [], hasMore: false }),
    discoverPosts: vi.fn().mockResolvedValue({ posts: [], hasMore: false }),
    searchByHashtag: vi.fn().mockResolvedValue({ posts: [], hasMore: false }),
    getTrendingHashtags: vi.fn().mockResolvedValue([]),
    toggleLike: vi.fn().mockResolvedValue({ liked: true }),
    addComment: vi.fn().mockResolvedValue({ id: 'c-1' }),
    getComments: vi.fn().mockResolvedValue({ comments: [], hasMore: false }),
    toggleCommentLike: vi.fn().mockResolvedValue({ liked: true }),
    deletePost: vi.fn().mockResolvedValue({ deleted: true }),
    bulkDeletePosts: vi.fn().mockResolvedValue({ deleted: 2 }),
    togglePinPost: vi.fn().mockResolvedValue({ pinned: true }),
    editCaption: vi.fn().mockResolvedValue({ id: 'p-1', content: 'new' }),
    trackView: vi.fn().mockResolvedValue(undefined),
    getChannelAnalytics: vi.fn().mockResolvedValue({ totalPosts: 0 }),
    toggleReaction: vi.fn().mockResolvedValue({ reaction: '🔥' }),
    toggleBookmark: vi.fn().mockResolvedValue({ bookmarked: true }),
    getBookmarkedPosts: vi.fn().mockResolvedValue({ posts: [], hasMore: false, cursor: null }),
    getScheduledPosts: vi.fn().mockResolvedValue([]),
    deleteScheduledPost: vi.fn().mockResolvedValue({ deleted: true }),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../../../middleware/userRateLimit', () => ({
  userRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../shared/upload', () => ({
  postMediaUpload: {
    array: () => (_req: any, _res: any, next: any) => next(),
    single: () => (_req: any, _res: any, next: any) => next(),
  },
  fileToPostImageUrl: vi.fn().mockResolvedValue('https://cdn/x.jpg'),
  fileToPostVideoUrl: vi.fn().mockResolvedValue('https://cdn/x.mp4'),
}));
vi.mock('../../../shared/moderation.service', () => ({
  isModerationConfigured: false,
  moderateImageUrl: vi.fn().mockResolvedValue({ safe: true }),
  moderateVideoUrl: vi.fn().mockResolvedValue({ safe: true }),
}));
vi.mock('../../../shared/cloudinary.service', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../post.service', () => mockPostService);

import { postRouter } from '../post.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/posts', postRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('post.router', () => {
  it('GET /posts/feed', async () => {
    const res = await request(makeApp()).get('/posts/feed');
    expect(res.status).toBe(200);
  });

  it('GET /posts/discover', async () => {
    const res = await request(makeApp()).get('/posts/discover');
    expect(res.status).toBe(200);
  });

  it('GET /posts/channel/:channelId', async () => {
    const res = await request(makeApp()).get('/posts/channel/c-1');
    expect(res.status).toBe(200);
  });

  it('GET /posts/trending-hashtags', async () => {
    const res = await request(makeApp()).get('/posts/trending-hashtags');
    expect(res.status).toBe(200);
  });

  it('GET /posts/hashtag/:tag', async () => {
    const res = await request(makeApp()).get('/posts/hashtag/react');
    expect(res.status).toBe(200);
  });

  it('GET /posts/bookmarks', async () => {
    const res = await request(makeApp()).get('/posts/bookmarks');
    expect(res.status).toBe(200);
  });

  it('GET /posts/scheduled/:channelId', async () => {
    const res = await request(makeApp()).get('/posts/scheduled/c-1');
    expect(res.status).toBe(200);
  });

  it('DELETE /posts/scheduled/:postId', async () => {
    const res = await request(makeApp()).delete('/posts/scheduled/p-1');
    expect(res.status).toBe(200);
  });

  it('POST /posts/:postId/react', async () => {
    const res = await request(makeApp()).post('/posts/p-1/react').send({ emoji: '🔥' });
    expect(res.status).toBe(200);
  });

  it('POST /posts/:postId/like', async () => {
    const res = await request(makeApp()).post('/posts/p-1/like');
    expect(res.status).toBe(200);
    expect(mockPostService.toggleLike).toHaveBeenCalledWith('p-1', 'user-1');
  });

  it('POST /posts/:postId/bookmark', async () => {
    const res = await request(makeApp()).post('/posts/p-1/bookmark');
    expect(res.status).toBe(200);
  });

  it('POST /posts/:postId/comments', async () => {
    const res = await request(makeApp()).post('/posts/p-1/comments').send({ content: 'great!' });
    expect([200, 201]).toContain(res.status);
  });

  it('GET /posts/:postId/comments', async () => {
    const res = await request(makeApp()).get('/posts/p-1/comments');
    expect(res.status).toBe(200);
  });

  it('POST /posts/comments/:commentId/like', async () => {
    const res = await request(makeApp()).post('/posts/comments/c-1/like');
    expect(res.status).toBe(200);
  });

  it('POST /posts/bulk-delete', async () => {
    const res = await request(makeApp()).post('/posts/bulk-delete').send({ postIds: ['p-1', 'p-2'] });
    expect(res.status).toBe(200);
  });

  it('DELETE /posts/:postId', async () => {
    const res = await request(makeApp()).delete('/posts/p-1');
    expect(res.status).toBe(200);
  });

  it('POST /posts/:postId/pin', async () => {
    const res = await request(makeApp()).post('/posts/p-1/pin');
    expect(res.status).toBe(200);
  });

  it('PATCH /posts/:postId/caption', async () => {
    const res = await request(makeApp()).patch('/posts/p-1/caption').send({ content: 'new' });
    expect(res.status).toBe(200);
  });

  it('POST /posts/:postId/view', async () => {
    const res = await request(makeApp()).post('/posts/p-1/view');
    expect(res.status).toBe(200);
  });

  it('GET /posts/analytics/:channelId', async () => {
    const res = await request(makeApp()).get('/posts/analytics/c-1');
    expect(res.status).toBe(200);
  });

  it('GET /posts/:postId returns single post', async () => {
    const res = await request(makeApp()).get('/posts/p-1');
    expect(res.status).toBe(200);
  });

  describe('POST /posts (create)', () => {
    it('rejects when channelId missing', async () => {
      const res = await request(makeApp()).post('/posts').send({});
      expect(res.status).toBe(400);
    });

    it('creates post with no media', async () => {
      mockPostService.createPost.mockResolvedValue({ id: 'p-1' });
      const res = await request(makeApp())
        .post('/posts')
        .send({ channelId: 'c-1', content: 'Hello world' });
      expect(res.status).toBe(201);
      expect(mockPostService.createPost).toHaveBeenCalled();
    });

    it('parses scheduled posts', async () => {
      mockPostService.createPost.mockResolvedValue({ id: 'p-1' });
      const res = await request(makeApp())
        .post('/posts')
        .send({
          channelId: 'c-1',
          content: 'x',
          scheduledAt: '2026-01-01T00:00:00Z',
        });
      expect(res.status).toBe(201);
    });

    it('parses music object string', async () => {
      mockPostService.createPost.mockResolvedValue({ id: 'p-1' });
      const res = await request(makeApp())
        .post('/posts')
        .send({
          channelId: 'c-1',
          content: 'x',
          music: JSON.stringify({ title: 'Song', previewUrl: 'p.m4a' }),
        });
      expect(res.status).toBe(201);
    });

    it('parses legacy music fields', async () => {
      mockPostService.createPost.mockResolvedValue({ id: 'p-1' });
      const res = await request(makeApp())
        .post('/posts')
        .send({
          channelId: 'c-1',
          content: 'x',
          musicTitle: 'T', musicArtist: 'A', musicPreviewUrl: 'p',
        });
      expect(res.status).toBe(201);
    });

    it('uses legacy mediaUrl body field', async () => {
      mockPostService.createPost.mockResolvedValue({ id: 'p-1' });
      const res = await request(makeApp())
        .post('/posts')
        .send({
          channelId: 'c-1',
          content: 'x',
          mediaUrl: 'https://cdn/x.jpg',
          mediaType: 'image',
        });
      expect(res.status).toBe(201);
    });

    it('parses music as object body', async () => {
      mockPostService.createPost.mockResolvedValue({ id: 'p-1' });
      const res = await request(makeApp())
        .post('/posts')
        .send({
          channelId: 'c-1',
          content: 'x',
          music: { title: 'Song', previewUrl: 'p.m4a', artist: 'A', artwork: 'art' },
        });
      expect(res.status).toBe(201);
    });
  });

  describe('error paths', () => {
    it('POST /posts/bulk-delete rejects empty postIds', async () => {
      const res = await request(makeApp()).post('/posts/bulk-delete').send({ postIds: [] });
      expect(res.status).toBe(400);
    });

    it('POST /posts/bulk-delete rejects missing postIds', async () => {
      const res = await request(makeApp()).post('/posts/bulk-delete').send({});
      expect(res.status).toBe(400);
    });
  });
});
