import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockCoinsService, mockPrisma, mockIO } = vi.hoisted(() => ({
  mockCoinsService: {
    getBalance: vi.fn().mockResolvedValue(100),
    purchaseCoins: vi.fn().mockResolvedValue({ ok: true, balance: 200 }),
    sendGift: vi.fn().mockResolvedValue({ giftId: 'g-1', coinAmount: 50 }),
    GIFT_TYPES: { ROSE: 5, HEART: 10, STAR: 50 },
  },
  mockPrisma: {
    story: { findUnique: vi.fn().mockResolvedValue({ userId: 'owner-1' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ displayName: 'Alice', avatarUrl: null }) },
  },
  mockIO: { to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../config/socket', () => ({ getIO: () => mockIO }));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../coins.service', () => mockCoinsService);

import { coinsRouter } from '../coins.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/coins', coinsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('coins.router', () => {
  it('GET /coins/balance', async () => {
    const res = await request(makeApp()).get('/coins/balance');
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(100);
  });

  it('POST /coins/purchase', async () => {
    const res = await request(makeApp())
      .post('/coins/purchase')
      .send({ packId: 'small' });
    expect(res.status).toBe(200);
    expect(mockCoinsService.purchaseCoins).toHaveBeenCalledWith('user-1', 'small');
  });

  it('POST /coins/purchase rejects missing packId', async () => {
    const res = await request(makeApp()).post('/coins/purchase').send({});
    expect(res.status).toBe(400);
  });

  it('GET /coins/gift-types returns mapping', async () => {
    const res = await request(makeApp()).get('/coins/gift-types');
    expect(res.status).toBe(200);
    expect(res.body.giftTypes).toHaveLength(3);
  });

  it('POST /coins/gift', async () => {
    const res = await request(makeApp())
      .post('/coins/gift')
      .send({ storyId: 's-1', giftType: 'ROSE' });
    expect(res.status).toBe(200);
    expect(mockCoinsService.sendGift).toHaveBeenCalledWith('user-1', 's-1', 'ROSE');
  });

  it('POST /coins/gift rejects missing fields', async () => {
    const res = await request(makeApp()).post('/coins/gift').send({ storyId: 's-1' });
    expect(res.status).toBe(400);
  });
});
