import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockGdrive } = vi.hoisted(() => ({
  mockGdrive: { streamFromDrive: vi.fn() },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u-1' };
    next();
  },
}));
vi.mock('../../../shared/gdrive.service', () => mockGdrive);

import { mediaRouter } from '../media.router';

function makeApp() {
  const app = express();
  app.use('/media', mediaRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('media.router', () => {
  it('GET /media/gdrive/:fileId returns 404 when not found', async () => {
    mockGdrive.streamFromDrive.mockResolvedValue(false);
    const res = await request(makeApp()).get('/media/gdrive/abc');
    expect(res.status).toBe(404);
  });

  it('GET /media/gdrive/:fileId streams successfully', async () => {
    mockGdrive.streamFromDrive.mockImplementation(async (_id: string, res: any) => {
      res.status(200).end('ok');
      return true;
    });
    const res = await request(makeApp()).get('/media/gdrive/abc');
    expect(res.status).toBe(200);
    expect(mockGdrive.streamFromDrive).toHaveBeenCalledWith('abc', expect.any(Object));
  });
});
