import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockMatchingService } = vi.hoisted(() => ({
  mockMatchingService: {
    createMatchRequest: vi.fn().mockResolvedValue({ request: { id: 'r-1' }, matchResult: null }),
    cancelMatchRequest: vi.fn().mockResolvedValue({ id: 'r-1', status: 'CANCELLED' }),
    getActiveRequest: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../config/socket', () => ({
  getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() })),
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../../../middleware/validate', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../matching.schema', () => ({
  createMatchRequestSchema: {},
}));
vi.mock('../matching.service', () => mockMatchingService);

import { matchingRouter } from '../matching.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/matching', matchingRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matching.router', () => {
  it('POST /matching/requests creates request (no immediate match)', async () => {
    const res = await request(makeApp())
      .post('/matching/requests')
      .send({ intent: 'CHAT' });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(false);
  });

  it('POST /matching/requests broadcasts when matched immediately', async () => {
    mockMatchingService.createMatchRequest.mockResolvedValueOnce({
      request: { id: 'r-1' },
      matchResult: {
        conversation: { id: 'c-1', participants: [] },
        matchedUserId: 'u-2',
        requestUserId: 'user-1',
        score: 0.8,
      },
    });
    const res = await request(makeApp())
      .post('/matching/requests')
      .send({ intent: 'CHAT' });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(true);
    expect(res.body.conversation.id).toBe('c-1');
  });

  it('DELETE /matching/requests/:id cancels', async () => {
    const res = await request(makeApp()).delete('/matching/requests/r-1');
    expect(res.status).toBe(200);
    expect(mockMatchingService.cancelMatchRequest).toHaveBeenCalledWith('r-1', 'user-1');
  });

  it('GET /matching/requests/active returns null', async () => {
    const res = await request(makeApp()).get('/matching/requests/active');
    expect(res.status).toBe(200);
    expect(res.body.request).toBeNull();
  });

  it('GET /matching/requests/active returns waiting', async () => {
    mockMatchingService.getActiveRequest.mockResolvedValue({ id: 'r-1', status: 'WAITING' });
    const res = await request(makeApp()).get('/matching/requests/active');
    expect(res.body.request.id).toBe('r-1');
  });
});
