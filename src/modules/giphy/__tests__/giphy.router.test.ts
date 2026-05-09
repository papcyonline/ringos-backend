import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockGiphy } = vi.hoisted(() => ({
  mockGiphy: {
    getTrending: vi.fn().mockResolvedValue([{ id: 'g1', url: 'u', previewUrl: 'p', width: 1, height: 1 }]),
    searchGifs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../giphy.service', () => mockGiphy);

import { giphyRouter } from '../giphy.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/giphy', giphyRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGiphy.getTrending.mockResolvedValue([]);
  mockGiphy.searchGifs.mockResolvedValue([]);
});

describe('giphy.router', () => {
  it('GET /giphy/trending', async () => {
    const res = await request(makeApp()).get('/giphy/trending').query({ limit: 10, offset: 0 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /giphy/trending clamps limit to defaults on invalid input', async () => {
    const res = await request(makeApp()).get('/giphy/trending').query({ limit: -5, offset: -100 });
    expect(res.status).toBe(200);
    expect(mockGiphy.getTrending).toHaveBeenCalledWith(24, 0);
  });

  it('GET /giphy/trending clamps limit to max', async () => {
    const res = await request(makeApp()).get('/giphy/trending').query({ limit: 999 });
    expect(res.status).toBe(200);
    expect(mockGiphy.getTrending).toHaveBeenCalledWith(50, 0);
  });

  it('GET /giphy/search', async () => {
    const res = await request(makeApp()).get('/giphy/search').query({ q: 'cats' });
    expect(res.status).toBe(200);
    expect(mockGiphy.searchGifs).toHaveBeenCalledWith('cats', 24, 0);
  });

  it('GET /giphy/search rejects empty q', async () => {
    const res = await request(makeApp()).get('/giphy/search').query({ q: '   ' });
    expect(res.status).toBe(400);
  });
});
