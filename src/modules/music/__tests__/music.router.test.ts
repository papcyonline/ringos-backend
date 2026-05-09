import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockMusic } = vi.hoisted(() => ({
  mockMusic: {
    getTrending: vi.fn().mockResolvedValue([]),
    searchMusic: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u-1' };
    next();
  },
}));
vi.mock('../music.service', () => mockMusic);

import { musicRouter } from '../music.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/music', musicRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('music.router', () => {
  it('GET /music/trending', async () => {
    const res = await request(makeApp()).get('/music/trending');
    expect(res.status).toBe(200);
    expect(mockMusic.getTrending).toHaveBeenCalledWith(24);
  });

  it('GET /music/trending clamps limit', async () => {
    await request(makeApp()).get('/music/trending').query({ limit: 999 });
    expect(mockMusic.getTrending).toHaveBeenCalledWith(50);
  });

  it('GET /music/search', async () => {
    const res = await request(makeApp()).get('/music/search').query({ q: 'pop' });
    expect(res.status).toBe(200);
    expect(mockMusic.searchMusic).toHaveBeenCalledWith('pop', 24);
  });

  it('GET /music/search rejects empty', async () => {
    const res = await request(makeApp()).get('/music/search').query({ q: '  ' });
    expect(res.status).toBe(400);
  });
});
