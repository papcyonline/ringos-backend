import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockStoryService, mockCoinsService, mockNotifService } = vi.hoisted(() => ({
  mockStoryService: {
    createStory: vi.fn().mockResolvedValue({ id: 's-1', slides: [] }),
    getStoryFeed: vi.fn().mockResolvedValue([]),
    getUserStories: vi.fn().mockResolvedValue(null),
    getDiscoverFeed: vi.fn().mockResolvedValue([]),
    getFollowingFeed: vi.fn().mockResolvedValue([]),
    markStoryViewed: vi.fn().mockResolvedValue(undefined),
    getStoryViewers: vi.fn().mockResolvedValue([]),
    likeStory: vi.fn().mockResolvedValue({ liked: true }),
    reactToStory: vi.fn().mockResolvedValue({ emoji: '❤️' }),
    clearStoryReaction: vi.fn().mockResolvedValue(undefined),
    replyToStory: vi.fn().mockResolvedValue({ conversationId: 'c-1', messageId: 'm-1' }),
    muteUserStories: vi.fn().mockResolvedValue(undefined),
    unmuteUserStories: vi.fn().mockResolvedValue(undefined),
    updateSlideCaption: vi.fn().mockResolvedValue({ updated: true }),
    deleteStory: vi.fn().mockResolvedValue({ deleted: true }),
    deleteSlide: vi.fn().mockResolvedValue({ deleted: true }),
    bumpStoryShare: vi.fn().mockResolvedValue(true),
    bumpStoryDownload: vi.fn().mockResolvedValue(true),
    bumpStoryRepost: vi.fn().mockResolvedValue(true),
  },
  mockCoinsService: {
    getStoryGiftStats: vi.fn().mockResolvedValue({ totalCoins: 0, totalGifts: 0, breakdown: [] }),
  },
  mockNotifService: {
    createNotification: vi.fn().mockResolvedValue(null),
    sendPostPush: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../config/database', () => ({
  prisma: {
    story: { findUnique: vi.fn().mockResolvedValue({ userId: 'owner-1' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ displayName: 'Alice', avatarUrl: null, isVerified: false }) },
  },
}));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../config/socket', () => ({
  getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() })),
}));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../../../shared/upload', () => ({
  storyMediaUpload: {
    single: () => (_req: any, _res: any, next: any) => next(),
    array: () => (_req: any, _res: any, next: any) => next(),
    fields: () => (_req: any, _res: any, next: any) => next(),
  },
}));
vi.mock('../../../shared/usage.service', () => ({
  getLimits: vi.fn().mockResolvedValue({ bioLength: 200, storyUploadMB: 50, pinnedChats: 3 }),
  isPro: vi.fn().mockResolvedValue(false),
}));
vi.mock('../story.service', () => mockStoryService);
vi.mock('../../coins/coins.service', () => mockCoinsService);
vi.mock('../../notification/notification.service', () => mockNotifService);

import { storyRouter } from '../story.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/stories', storyRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('story.router', () => {
  it('GET /stories/feed', async () => {
    const res = await request(makeApp()).get('/stories/feed');
    expect(res.status).toBe(200);
  });

  it('GET /stories/discover', async () => {
    const res = await request(makeApp()).get('/stories/discover');
    expect(res.status).toBe(200);
  });

  it('GET /stories/following', async () => {
    const res = await request(makeApp()).get('/stories/following');
    expect(res.status).toBe(200);
  });

  it('POST /stories/mute/:userId', async () => {
    const res = await request(makeApp()).post('/stories/mute/u-2');
    expect([200, 201, 204]).toContain(res.status);
  });

  it('DELETE /stories/mute/:userId', async () => {
    const res = await request(makeApp()).delete('/stories/mute/u-2');
    expect([200, 204]).toContain(res.status);
  });

  it('POST /stories/:id/view', async () => {
    const res = await request(makeApp()).post('/stories/s-1/view');
    expect([200, 201, 204]).toContain(res.status);
  });

  it('GET /stories/:id/viewers', async () => {
    const res = await request(makeApp()).get('/stories/s-1/viewers');
    expect(res.status).toBe(200);
  });

  it('POST /stories/:id/like', async () => {
    const res = await request(makeApp()).post('/stories/s-1/like');
    expect([200, 201]).toContain(res.status);
  });

  it('POST /stories/:id/react', async () => {
    const res = await request(makeApp()).post('/stories/s-1/react').send({ emoji: '❤️' });
    expect([200, 201]).toContain(res.status);
  });

  it('DELETE /stories/:id/react', async () => {
    const res = await request(makeApp()).delete('/stories/s-1/react');
    expect([200, 204]).toContain(res.status);
  });

  it('POST /stories/:id/reply', async () => {
    const res = await request(makeApp()).post('/stories/s-1/reply').send({ text: 'nice' });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /stories/:id/share', async () => {
    const res = await request(makeApp()).post('/stories/s-1/share');
    expect([200, 201]).toContain(res.status);
  });

  it('POST /stories/:id/download', async () => {
    const res = await request(makeApp()).post('/stories/s-1/download');
    expect([200, 201]).toContain(res.status);
  });

  it('POST /stories/:id/repost', async () => {
    const res = await request(makeApp()).post('/stories/s-1/repost');
    expect([200, 201]).toContain(res.status);
  });

  it('GET /stories/:id/gift-stats', async () => {
    const res = await request(makeApp()).get('/stories/s-1/gift-stats');
    expect(res.status).toBe(200);
  });

  it('PATCH /stories/slides/:slideId/caption', async () => {
    const res = await request(makeApp()).patch('/stories/slides/sl-1/caption').send({ caption: 'new' });
    expect(res.status).toBe(200);
  });

  it('DELETE /stories/slides/:slideId', async () => {
    const res = await request(makeApp()).delete('/stories/slides/sl-1');
    expect([200, 204]).toContain(res.status);
  });

  it('DELETE /stories/:id', async () => {
    const res = await request(makeApp()).delete('/stories/s-1');
    expect([200, 204]).toContain(res.status);
  });

  describe('POST /stories (create)', () => {
    it('rejects when no files', async () => {
      const res = await request(makeApp()).post('/stories').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /stories/:id/react errors', () => {
    it('rejects missing emoji', async () => {
      const res = await request(makeApp()).post('/stories/s-1/react').send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 when story not found', async () => {
      mockStoryService.reactToStory.mockResolvedValueOnce(null);
      const res = await request(makeApp()).post('/stories/s-1/react').send({ emoji: '🔥' });
      expect(res.status).toBe(404);
    });

    it('surfaces 400 from service', async () => {
      mockStoryService.reactToStory.mockRejectedValueOnce(
        Object.assign(new Error('Bad emoji'), { statusCode: 400 }),
      );
      const res = await request(makeApp()).post('/stories/s-1/react').send({ emoji: '🚫' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /stories/slides/:slideId/caption errors', () => {
    it('returns 404 when slide not found', async () => {
      mockStoryService.updateSlideCaption.mockResolvedValueOnce({ updated: false, reason: 'not_found' });
      const res = await request(makeApp()).patch('/stories/slides/sl-1/caption').send({ caption: 'x' });
      expect(res.status).toBe(404);
    });

    it('returns 403 when not authorized', async () => {
      mockStoryService.updateSlideCaption.mockResolvedValueOnce({ updated: false, reason: 'forbidden' });
      const res = await request(makeApp()).patch('/stories/slides/sl-1/caption').send({ caption: 'x' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /stories/slides/:slideId errors', () => {
    it('returns 404', async () => {
      mockStoryService.deleteSlide.mockResolvedValueOnce({ deleted: false, reason: 'not_found' });
      const res = await request(makeApp()).delete('/stories/slides/sl-1');
      expect(res.status).toBe(404);
    });

    it('returns 403 when forbidden', async () => {
      mockStoryService.deleteSlide.mockResolvedValueOnce({ deleted: false, reason: 'forbidden' });
      const res = await request(makeApp()).delete('/stories/slides/sl-1');
      expect(res.status).toBe(403);
    });

    it('emits story:deleted when full story is gone', async () => {
      mockStoryService.deleteSlide.mockResolvedValueOnce({ deleted: true, storyDeleted: true, storyId: 's-1' });
      const res = await request(makeApp()).delete('/stories/slides/sl-1');
      expect(res.status).toBe(200);
      expect(res.body.storyDeleted).toBe(true);
    });
  });

  describe('POST /stories/:id/reply 404', () => {
    it('returns 404 when reply target story not found', async () => {
      mockStoryService.replyToStory.mockResolvedValueOnce(null);
      const res = await request(makeApp()).post('/stories/s-1/reply').send({ text: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /stories/:id/like (unlike)', () => {
    it('passes through when liked=false (no notification)', async () => {
      const res = await request(makeApp()).post('/stories/s-1/like').send({ liked: false });
      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /stories/:id error paths', () => {
    it('returns 404 when story not found', async () => {
      mockStoryService.deleteStory.mockResolvedValueOnce({ deleted: false, reason: 'not_found' });
      const res = await request(makeApp()).delete('/stories/s-1');
      expect(res.status).toBe(404);
    });

    it('returns 403 when not authorized', async () => {
      mockStoryService.deleteStory.mockResolvedValueOnce({ deleted: false, reason: 'forbidden' });
      const res = await request(makeApp()).delete('/stories/s-1');
      expect(res.status).toBe(403);
    });

    it('returns 500 on service error', async () => {
      mockStoryService.deleteStory.mockRejectedValueOnce(new Error('boom'));
      const res = await request(makeApp()).delete('/stories/s-1');
      expect(res.status).toBe(500);
    });
  });

  describe('error paths', () => {
    it('GET /stories/feed returns 500 on service error', async () => {
      mockStoryService.getStoryFeed.mockRejectedValueOnce(new Error('boom'));
      const res = await request(makeApp()).get('/stories/feed');
      expect(res.status).toBe(500);
    });

    it('GET /stories/discover returns 500 on service error', async () => {
      mockStoryService.getDiscoverFeed.mockRejectedValueOnce(new Error('boom'));
      const res = await request(makeApp()).get('/stories/discover');
      expect(res.status).toBe(500);
    });

    it('POST /stories/:id/view returns 500', async () => {
      mockStoryService.markStoryViewed.mockRejectedValueOnce(new Error('boom'));
      const res = await request(makeApp()).post('/stories/s-1/view');
      expect(res.status).toBe(500);
    });

    it('GET /stories/:id/viewers 500', async () => {
      mockStoryService.getStoryViewers.mockRejectedValueOnce(new Error('boom'));
      const res = await request(makeApp()).get('/stories/s-1/viewers');
      expect(res.status).toBe(500);
    });

    it('POST /stories/:id/like 500', async () => {
      mockStoryService.likeStory.mockRejectedValueOnce(new Error('boom'));
      const res = await request(makeApp()).post('/stories/s-1/like');
      expect(res.status).toBe(500);
    });
  });
});
