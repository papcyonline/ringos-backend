import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockSafetyService, mockHandoffService } = vi.hoisted(() => ({
  mockSafetyService: {
    reportUser: vi.fn().mockResolvedValue({ id: 'r-1' }),
    blockUser: vi.fn().mockResolvedValue({ id: 'b-1' }),
    unblockUser: vi.fn().mockResolvedValue({ unblocked: true }),
    getBlockedUsers: vi.fn().mockResolvedValue([]),
  },
  mockHandoffService: {
    createHandoffRequest: vi.fn().mockResolvedValue({ matchRequestId: 'r-1' }),
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
vi.mock('../../../middleware/validate', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../safety.service', () => mockSafetyService);
vi.mock('../handoff.service', () => mockHandoffService);

import { safetyRouter } from '../safety.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/safety', safetyRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('safety.router', () => {
  it('POST /safety/report', async () => {
    const res = await request(makeApp())
      .post('/safety/report')
      .send({ reportedId: 'u-2', reason: 'spam' });
    expect(res.status).toBe(201);
    expect(mockSafetyService.reportUser).toHaveBeenCalled();
  });

  it('POST /safety/block', async () => {
    const res = await request(makeApp())
      .post('/safety/block')
      .send({ blockedId: 'u-2' });
    expect(res.status).toBe(201);
    expect(mockSafetyService.blockUser).toHaveBeenCalledWith('user-1', 'u-2');
  });

  it('DELETE /safety/block/:blockedId', async () => {
    const res = await request(makeApp()).delete('/safety/block/u-2');
    expect(res.status).toBe(200);
    expect(mockSafetyService.unblockUser).toHaveBeenCalledWith('user-1', 'u-2');
  });

  it('GET /safety/blocked', async () => {
    const res = await request(makeApp()).get('/safety/blocked');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('POST /safety/handoff', async () => {
    const res = await request(makeApp())
      .post('/safety/handoff')
      .send({ aiSessionId: 's-1', mood: 'SAD' });
    expect(res.status).toBe(201);
    expect(mockHandoffService.createHandoffRequest).toHaveBeenCalled();
  });
});
