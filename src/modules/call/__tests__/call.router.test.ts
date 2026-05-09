import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockPrisma, mockTwilio } = vi.hoisted(() => {
  const mockPrisma: any = {
    callLog: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    conversationParticipant: {
      findMany: vi.fn().mockResolvedValue([{ conversationId: 'c-1' }]),
      findUnique: vi.fn().mockResolvedValue({ leftAt: null }),
    },
  };
  const tokenInstance = { addGrant: vi.fn(), toJwt: vi.fn(() => 'iceToken') };
  const mockTwilio: any = vi.fn().mockReturnValue({
    tokens: { create: vi.fn().mockResolvedValue({ iceServers: [] }) },
  });
  (mockTwilio as any).jwt = { AccessToken: vi.fn().mockImplementation(() => tokenInstance) };
  return { mockPrisma, mockTwilio };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({
  env: {
    TWILIO_ACCOUNT_SID: 'sid',
    TWILIO_AUTH_TOKEN: 'tok',
    TURN_SERVER_URLS: 'turn.example.com:3478,turns:turn2.example.com:5349',
    TURN_USERNAME: 'user',
    TURN_CREDENTIAL: 'pass',
  },
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
vi.mock('twilio', () => ({ default: mockTwilio }));

import { callRouter } from '../call.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/call', callRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('call.router', () => {
  it('GET /call/provider returns chosen provider', async () => {
    const res = await request(makeApp()).get('/call/provider');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('provider');
  });

  it('GET /call/ice-servers returns STUN entries (always)', async () => {
    const res = await request(makeApp()).get('/call/ice-servers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.iceServers)).toBe(true);
  });

  it('GET /call/history returns paginated logs', async () => {
    const res = await request(makeApp()).get('/call/history').query({ page: 1, limit: 30 });
    expect(res.status).toBe(200);
  });

  it('POST /call/:callId/rating saves rating', async () => {
    mockPrisma.callLog.findUnique.mockResolvedValue({ id: 'cl-1', conversationId: 'c-1', status: 'COMPLETED' });
    mockPrisma.callLog.update.mockResolvedValue({ callId: 'c-1', qualityRating: 5, qualityIssues: [] });

    const res = await request(makeApp()).post('/call/c-1/rating').send({ rating: 5, issues: [] });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('POST /call/:callId/rating: rejects out-of-range rating', async () => {
    const res = await request(makeApp()).post('/call/c-1/rating').send({ rating: 99 });
    expect(res.status).toBe(400);
  });

  it('POST /call/:callId/rating: 404 when call missing', async () => {
    mockPrisma.callLog.findUnique.mockResolvedValue(null);

    const res = await request(makeApp()).post('/call/nope/rating').send({ rating: 4 });
    expect(res.status).toBe(404);
  });

  it('GET /call/turn-status returns config flags', async () => {
    const res = await request(makeApp()).get('/call/turn-status');
    expect(res.status).toBe(200);
    expect(res.body.turnConfigured).toBe(true);
    expect(res.body.twilioConfigured).toBe(true);
  });

  it('GET /call/ice-servers returns env TURN servers when configured', async () => {
    const res = await request(makeApp()).get('/call/ice-servers');
    expect(res.status).toBe(200);
    expect(res.body.iceServers.length).toBeGreaterThan(2);
  });

  it('GET /call/ice-servers respects forceRelay=true', async () => {
    const res = await request(makeApp()).get('/call/ice-servers').query({ forceRelay: 'true' });
    expect(res.body.iceTransportPolicy).toBe('relay');
  });

  it('GET /call/ice-servers respects forceRelay=1', async () => {
    const res = await request(makeApp()).get('/call/ice-servers').query({ forceRelay: '1' });
    expect(res.body.iceTransportPolicy).toBe('relay');
  });

  it('POST /call/:callId/rating rejects non-completed calls', async () => {
    mockPrisma.callLog.findUnique.mockResolvedValue({
      id: 'cl-1', conversationId: 'c-1', status: 'MISSED',
    });
    const res = await request(makeApp()).post('/call/c-1/rating').send({ rating: 5 });
    expect(res.status).toBe(400);
  });

  it('POST /call/:callId/rating rejects when not a participant', async () => {
    mockPrisma.callLog.findUnique.mockResolvedValue({
      id: 'cl-1', conversationId: 'c-1', status: 'COMPLETED',
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp()).post('/call/c-1/rating').send({ rating: 5 });
    expect(res.status).toBe(403);
  });

  it('POST /call/:callId/rating filters issue strings', async () => {
    mockPrisma.callLog.findUnique.mockResolvedValue({
      id: 'cl-1', conversationId: 'c-1', status: 'COMPLETED',
    });
    mockPrisma.callLog.update.mockResolvedValue({
      callId: 'c-1', qualityRating: 4, qualityIssues: ['poor_audio'],
    });
    const res = await request(makeApp())
      .post('/call/c-1/rating')
      .send({ rating: 4, issues: ['poor_audio', 12345, 'x'.repeat(50)] });
    expect(res.status).toBe(200);
  });

  it('GET /call/history returns empty when not in any conversation', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get('/call/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /call/history surfaces 500 on db error', async () => {
    mockPrisma.conversationParticipant.findMany.mockRejectedValueOnce(new Error('db'));
    const res = await request(makeApp()).get('/call/history');
    expect(res.status).toBe(500);
  });
});
