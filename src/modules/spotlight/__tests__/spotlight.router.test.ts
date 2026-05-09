import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockSpotlightService, mockLiveKit, liveBroadcasters } = vi.hoisted(() => {
  const liveBroadcasters = new Map<string, any>();
  return {
    mockSpotlightService: {
      getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>()),
      buildBroadcasterList: vi.fn().mockResolvedValue([]),
      areUsersBlocked: vi.fn().mockResolvedValue(false),
    },
    mockLiveKit: {
      generateSpotlightToken: vi.fn().mockResolvedValue('jwt'),
      LIVEKIT_URL: 'wss://lk',
    },
    liveBroadcasters,
  };
});

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
vi.mock('../spotlight.service', () => mockSpotlightService);
vi.mock('../spotlight.gateway', () => ({ liveBroadcasters }));
vi.mock('../spotlight.livekit', () => mockLiveKit);

import { spotlightRouter } from '../spotlight.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/spotlight', spotlightRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  liveBroadcasters.clear();
});

describe('spotlight.router', () => {
  it('GET /spotlight/live', async () => {
    const res = await request(makeApp()).get('/spotlight/live');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.broadcasters)).toBe(true);
  });

  it('POST /spotlight/livekit-token broadcaster', async () => {
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ broadcasterId: 'user-1', role: 'broadcaster' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('jwt');
    expect(res.body.url).toBe('wss://lk');
  });

  it('POST /spotlight/livekit-token rejects missing broadcasterId', async () => {
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ role: 'broadcaster' });
    expect(res.status).toBe(400);
  });

  it('POST /spotlight/livekit-token rejects bad role', async () => {
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ broadcasterId: 'u-2', role: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('POST /spotlight/livekit-token rejects broadcaster impersonation', async () => {
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ broadcasterId: 'other', role: 'broadcaster' });
    expect(res.status).toBe(403);
  });

  it('POST /spotlight/livekit-token viewer 404 when broadcaster offline', async () => {
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ broadcasterId: 'u-2', role: 'viewer' });
    expect(res.status).toBe(404);
  });

  it('POST /spotlight/livekit-token viewer 403 when blocked', async () => {
    liveBroadcasters.set('u-2', {});
    mockSpotlightService.areUsersBlocked.mockResolvedValueOnce(true);
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ broadcasterId: 'u-2', role: 'viewer' });
    expect(res.status).toBe(403);
  });

  it('POST /spotlight/livekit-token viewer success', async () => {
    liveBroadcasters.set('u-2', {});
    const res = await request(makeApp())
      .post('/spotlight/livekit-token')
      .send({ broadcasterId: 'u-2', role: 'viewer' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('jwt');
  });
});
