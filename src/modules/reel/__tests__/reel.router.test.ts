import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockReelService, mockStatsService } = vi.hoisted(() => ({
  mockReelService: {
    createReel: vi.fn().mockResolvedValue({ id: 'r-1' }),
    getReelFeed: vi.fn().mockResolvedValue({ reels: [], nextCursor: null }),
    likeReel: vi.fn().mockResolvedValue(undefined),
    unlikeReel: vi.fn().mockResolvedValue(undefined),
    repostReel: vi.fn().mockResolvedValue(undefined),
    unrepostReel: vi.fn().mockResolvedValue(undefined),
    markReelViewed: vi.fn().mockResolvedValue(undefined),
    deleteReel: vi.fn().mockResolvedValue(undefined),
    addReelComment: vi.fn().mockResolvedValue({ id: 'c-1' }),
    getReelComments: vi.fn().mockResolvedValue({ comments: [], nextCursor: null }),
    deleteReelComment: vi.fn().mockResolvedValue(undefined),
    countReelsCreatedSince: vi.fn().mockResolvedValue(0),
    reactToReel: vi.fn().mockResolvedValue({ emoji: '❤️' }),
    clearReelReaction: vi.fn().mockResolvedValue(undefined),
  },
  mockStatsService: {
    getReelStats: vi.fn().mockResolvedValue({ views: 100, likes: 5 }),
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
vi.mock('../../../shared/upload', () => ({
  storyMediaUpload: {
    single: () => (req: any, _res: any, next: any) => {
      // Inject a fake file when the test sets a marker header
      if (req.headers?.['x-with-file'] === '1') {
        req.file = { buffer: Buffer.from('v'), originalname: 'r.mp4', mimetype: 'video/mp4' };
      }
      next();
    },
  },
}));
vi.mock('../reel.service', () => mockReelService);
vi.mock('../reel.stats.service', () => mockStatsService);

import { reelRouter } from '../reel.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/reels', reelRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reel.router', () => {
  it('GET /reels/feed', async () => {
    const res = await request(makeApp()).get('/reels/feed');
    expect(res.status).toBe(200);
  });

  it('POST /reels/:id/like', async () => {
    const res = await request(makeApp()).post('/reels/r-1/like');
    expect(res.status).toBe(200);
    expect(mockReelService.likeReel).toHaveBeenCalledWith('r-1', 'user-1');
  });

  it('DELETE /reels/:id/like', async () => {
    const res = await request(makeApp()).delete('/reels/r-1/like');
    expect(res.status).toBe(200);
    expect(mockReelService.unlikeReel).toHaveBeenCalledWith('r-1', 'user-1');
  });

  it('POST /reels/:id/react', async () => {
    const res = await request(makeApp()).post('/reels/r-1/react').send({ emoji: '❤️' });
    expect(res.status).toBe(200);
  });

  it('DELETE /reels/:id/react', async () => {
    const res = await request(makeApp()).delete('/reels/r-1/react');
    expect(res.status).toBe(200);
  });

  it('POST /reels/:id/repost', async () => {
    const res = await request(makeApp()).post('/reels/r-1/repost');
    expect(res.status).toBe(200);
  });

  it('DELETE /reels/:id/repost', async () => {
    const res = await request(makeApp()).delete('/reels/r-1/repost');
    expect(res.status).toBe(200);
  });

  it('POST /reels/:id/view', async () => {
    const res = await request(makeApp()).post('/reels/r-1/view').send({ watchedSec: 5 });
    expect(res.status).toBe(200);
  });

  it('GET /reels/:id/stats', async () => {
    const res = await request(makeApp()).get('/reels/r-1/stats');
    expect(res.status).toBe(200);
    expect(mockStatsService.getReelStats).toHaveBeenCalled();
  });

  it('GET /reels/:id/comments', async () => {
    const res = await request(makeApp()).get('/reels/r-1/comments');
    expect(res.status).toBe(200);
  });

  it('POST /reels/:id/comments', async () => {
    const res = await request(makeApp()).post('/reels/r-1/comments').send({ content: 'great' });
    expect(res.status).toBe(200);
  });

  it('DELETE /reels/comments/:commentId', async () => {
    const res = await request(makeApp()).delete('/reels/comments/c-1');
    expect(res.status).toBe(200);
  });

  it('DELETE /reels/:id', async () => {
    const res = await request(makeApp()).delete('/reels/r-1');
    expect(res.status).toBe(200);
    expect(mockReelService.deleteReel).toHaveBeenCalledWith('r-1', 'user-1');
  });

  it('error path: service throws', async () => {
    mockReelService.likeReel.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    const res = await request(makeApp()).post('/reels/r-1/like');
    expect(res.status).toBe(500);
  });

  describe('POST / (create)', () => {
    it('rejects when no file', async () => {
      const res = await request(makeApp()).post('/reels').send({});
      expect(res.status).toBe(400);
    });

    it('creates reel with file', async () => {
      const res = await request(makeApp())
        .post('/reels')
        .set('x-with-file', '1')
        .send({ caption: 'hello' });
      expect(res.status).toBe(200);
      expect(mockReelService.createReel).toHaveBeenCalled();
    });

    it('rejects when rate limited', async () => {
      mockReelService.countReelsCreatedSince.mockResolvedValueOnce(15);
      const res = await request(makeApp())
        .post('/reels')
        .set('x-with-file', '1');
      expect(res.status).toBe(429);
    });

    it('rejects malformed videoEdits JSON', async () => {
      const res = await request(makeApp())
        .post('/reels')
        .set('x-with-file', '1')
        .send({ videoEdits: 'not json' });
      expect(res.status).toBe(400);
    });

    it('parses valid videoEdits JSON', async () => {
      const res = await request(makeApp())
        .post('/reels')
        .set('x-with-file', '1')
        .send({
          caption: 'x',
          videoEdits: JSON.stringify({ trim: { start: 0, end: 10 } }),
          videoVolume: '0.5',
          musicVolume: '0.3',
          durationSec: '15',
        });
      expect(res.status).toBe(200);
    });

    it('clamps out-of-range volumes', async () => {
      const res = await request(makeApp())
        .post('/reels')
        .set('x-with-file', '1')
        .send({ caption: 'x', videoVolume: '5', musicVolume: '-1' });
      expect(res.status).toBe(200);
    });

    it('surfaces 400 errors from service', async () => {
      mockReelService.createReel.mockRejectedValueOnce(
        Object.assign(new Error('Bad video'), { statusCode: 400, code: 'BAD_VIDEO' }),
      );
      const res = await request(makeApp())
        .post('/reels')
        .set('x-with-file', '1');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /reels/feed audience filter', () => {
    it('passes "following"', async () => {
      await request(makeApp()).get('/reels/feed').query({ audience: 'following' });
      expect(mockReelService.getReelFeed).toHaveBeenCalledWith('user-1', undefined, expect.any(Number), 'following');
    });

    it('passes "mine"', async () => {
      await request(makeApp()).get('/reels/feed').query({ audience: 'mine' });
      expect(mockReelService.getReelFeed).toHaveBeenCalledWith('user-1', undefined, expect.any(Number), 'mine');
    });

    it('clamps limit to 30 max', async () => {
      await request(makeApp()).get('/reels/feed').query({ limit: 9999 });
      expect(mockReelService.getReelFeed).toHaveBeenCalledWith('user-1', undefined, 30, 'all');
    });
  });

  describe('GET /reels/:id/stats errors', () => {
    it('surfaces 403', async () => {
      mockStatsService.getReelStats.mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { statusCode: 403 }),
      );
      const res = await request(makeApp()).get('/reels/r-1/stats');
      expect(res.status).toBe(403);
    });

    it('surfaces 404', async () => {
      mockStatsService.getReelStats.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { statusCode: 404 }),
      );
      const res = await request(makeApp()).get('/reels/r-1/stats');
      expect(res.status).toBe(404);
    });

    it('falls back to 500', async () => {
      mockStatsService.getReelStats.mockRejectedValueOnce(new Error('mystery'));
      const res = await request(makeApp()).get('/reels/r-1/stats');
      expect(res.status).toBe(500);
    });
  });

  describe('react errors', () => {
    it('returns 404 when reel not found', async () => {
      mockReelService.reactToReel.mockResolvedValueOnce(null);
      const res = await request(makeApp()).post('/reels/r-1/react').send({ emoji: '❤️' });
      expect(res.status).toBe(404);
    });

    it('surfaces 400', async () => {
      mockReelService.reactToReel.mockRejectedValueOnce(
        Object.assign(new Error('Invalid emoji'), { statusCode: 400 }),
      );
      const res = await request(makeApp()).post('/reels/r-1/react').send({ emoji: 'bad' });
      expect(res.status).toBe(400);
    });
  });

  describe('comments error paths', () => {
    it('addComment surfaces 400', async () => {
      mockReelService.addReelComment.mockRejectedValueOnce(
        Object.assign(new Error('Empty'), { statusCode: 400 }),
      );
      const res = await request(makeApp()).post('/reels/r-1/comments').send({ content: '' });
      expect(res.status).toBe(400);
    });

    it('deleteComment surfaces 403', async () => {
      mockReelService.deleteReelComment.mockRejectedValueOnce(
        Object.assign(new Error('Not yours'), { statusCode: 403 }),
      );
      const res = await request(makeApp()).delete('/reels/comments/c-1');
      expect(res.status).toBe(403);
    });
  });

  describe('delete reel errors', () => {
    it('surfaces 403', async () => {
      mockReelService.deleteReel.mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { statusCode: 403 }),
      );
      const res = await request(makeApp()).delete('/reels/r-1');
      expect(res.status).toBe(403);
    });

    it('surfaces 404', async () => {
      mockReelService.deleteReel.mockRejectedValueOnce(
        Object.assign(new Error('Missing'), { statusCode: 404 }),
      );
      const res = await request(makeApp()).delete('/reels/r-1');
      expect(res.status).toBe(404);
    });
  });
});
