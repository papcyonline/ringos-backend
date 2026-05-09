import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserService, mockFollowService, mockLikeService } = vi.hoisted(() => ({
  mockUserService: {
    listUsers: vi.fn().mockResolvedValue({ users: [], page: 1, hasMore: false }),
    getProfile: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Alice' }),
    getUserById: vi.fn().mockResolvedValue({ id: 'u-2', displayName: 'Bob' }),
    updateAvailability: vi.fn().mockResolvedValue({ id: 'user-1', availableFor: ['text'] }),
    stopAvailability: vi.fn().mockResolvedValue({ id: 'user-1', availableFor: ['text'] }),
    uploadAvatar: vi.fn().mockResolvedValue({ id: 'user-1', avatarUrl: 'https://cdn/x.jpg' }),
    setOnline: vi.fn().mockResolvedValue(undefined),
    setOffline: vi.fn().mockResolvedValue(undefined),
    updatePreference: vi.fn().mockResolvedValue({ language: 'en' }),
    updatePrivacy: vi.fn().mockResolvedValue({ id: 'user-1' }),
    updateProfile: vi.fn().mockResolvedValue({ id: 'user-1' }),
    setVerified: vi.fn().mockResolvedValue({ id: 'user-1', isVerified: true }),
    removeVerified: vi.fn().mockResolvedValue({ id: 'user-1', isVerified: false }),
    adminSetVerified: vi.fn().mockResolvedValue({ id: 'user-1', isVerified: true }),
    deleteAccount: vi.fn().mockResolvedValue({ email: 'a@b.com', displayName: 'Alice' }),
    setPhoneHash: vi.fn().mockResolvedValue({ id: 'user-1', phoneLookup: 'hash' }),
    removePhoneHash: vi.fn().mockResolvedValue({ id: 'user-1', phoneLookup: null }),
    syncContacts: vi.fn().mockResolvedValue([]),
  },
  mockFollowService: {
    followUser: vi.fn().mockResolvedValue({ following: true }),
    unfollowUser: vi.fn().mockResolvedValue({ following: false }),
    getFollowers: vi.fn().mockResolvedValue([]),
    getFollowing: vi.fn().mockResolvedValue([]),
    isFollowing: vi.fn().mockResolvedValue(false),
  },
  mockLikeService: {
    likeUser: vi.fn().mockResolvedValue({ liked: true }),
    unlikeUser: vi.fn().mockResolvedValue({ liked: false }),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
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
vi.mock('../../../middleware/validate', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../shared/upload', () => ({
  avatarUpload: {
    single: () => (_req: any, _res: any, next: any) => next(),
  },
  fileToAvatarUrl: vi.fn().mockResolvedValue('https://cdn/x.jpg'),
}));
vi.mock('../../../shared/redis.service', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, resetAt: Date.now() }),
}));
vi.mock('../../../shared/usage.service', () => ({
  getUsageSummary: vi.fn().mockResolvedValue({
    isPro: false, calls: { usedMins: 0, limitMins: 5, resetAt: '' },
    kora: { sessionsUsed: 0, limitSessions: 2, messagesUsed: 0, limitMessages: 3, resetAt: '' },
    transcription: { used: 0, limit: 3, resetAt: '' },
    limits: { bioLength: 200, storyUploadMB: 50, pinnedChats: 3 },
  }),
}));
vi.mock('../../notification/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(null),
  sendPostPush: vi.fn().mockResolvedValue(null),
}));
vi.mock('../user.schema', () => ({
  updatePreferenceSchema: {},
  updateAvailabilitySchema: {},
  updatePrivacySchema: {},
  updateProfileSchema: {},
}));
vi.mock('../user.service', () => mockUserService);
vi.mock('../follow.service', () => mockFollowService);
vi.mock('../like.service', () => mockLikeService);

import { userRouter } from '../user.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/users', userRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('user.router', () => {
  it('GET /users', async () => {
    const res = await request(makeApp()).get('/users');
    expect(res.status).toBe(200);
  });

  it('GET /users/me', async () => {
    const res = await request(makeApp()).get('/users/me');
    expect(res.status).toBe(200);
  });

  it('GET /users/me/usage', async () => {
    const res = await request(makeApp()).get('/users/me/usage');
    expect(res.status).toBe(200);
  });

  it('PUT /users/me/availability', async () => {
    const res = await request(makeApp()).put('/users/me/availability').send({ availableFor: ['text'] });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('PUT /users/me/preferences', async () => {
    const res = await request(makeApp()).put('/users/me/preferences').send({ language: 'fr' });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('PUT /users/me/privacy', async () => {
    const res = await request(makeApp()).put('/users/me/privacy').send({ isProfilePublic: false });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('PUT /users/me/profile', async () => {
    const res = await request(makeApp()).put('/users/me/profile').send({ displayName: 'Alice2' });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('GET /users/me/following', async () => {
    const res = await request(makeApp()).get('/users/me/following');
    expect(res.status).toBe(200);
  });

  it('POST /users/me/verify', async () => {
    const res = await request(makeApp()).post('/users/me/verify');
    expect([200, 201, 204]).toContain(res.status);
  });

  it('DELETE /users/me/verify', async () => {
    const res = await request(makeApp()).delete('/users/me/verify');
    expect(res.status).toBe(200);
  });

  it('DELETE /users/me', async () => {
    const res = await request(makeApp()).delete('/users/me');
    expect([200, 204]).toContain(res.status);
  });

  it('GET /users/:id', async () => {
    const res = await request(makeApp()).get('/users/u-2');
    expect(res.status).toBe(200);
  });

  it('POST /users/:id/follow', async () => {
    const res = await request(makeApp()).post('/users/u-2/follow');
    expect([200, 201, 204]).toContain(res.status);
  });

  it('DELETE /users/:id/follow', async () => {
    const res = await request(makeApp()).delete('/users/u-2/follow');
    expect([200, 204]).toContain(res.status);
  });

  it('POST /users/:id/like', async () => {
    const res = await request(makeApp()).post('/users/u-2/like');
    expect([200, 201, 204]).toContain(res.status);
  });

  it('DELETE /users/:id/like', async () => {
    const res = await request(makeApp()).delete('/users/u-2/like');
    expect([200, 204]).toContain(res.status);
  });

  it('GET /users/:id/followers', async () => {
    const res = await request(makeApp()).get('/users/u-2/followers');
    expect(res.status).toBe(200);
  });

  it('GET /users/:id/following', async () => {
    const res = await request(makeApp()).get('/users/u-2/following');
    expect(res.status).toBe(200);
  });

  it('PUT /users/me/phone', async () => {
    const res = await request(makeApp()).put('/users/me/phone').send({ phoneHash: 'a'.repeat(20) });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('DELETE /users/me/phone', async () => {
    const res = await request(makeApp()).delete('/users/me/phone');
    expect(res.status).toBe(200);
  });

  it('POST /users/me/contacts/sync', async () => {
    const res = await request(makeApp()).post('/users/me/contacts/sync').send({ hashes: ['a'.repeat(32), 'b'.repeat(32)] });
    expect([200, 201, 204]).toContain(res.status);
  });

  describe('POST /users/me/avatar', () => {
    it('rejects when no file', async () => {
      const res = await request(makeApp()).post('/users/me/avatar').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /users/admin/verify', () => {
    it('rejects without admin secret', async () => {
      const res = await request(makeApp()).post('/users/admin/verify').send({});
      expect([403, 429]).toContain(res.status);
    });

    it('rejects with wrong admin secret', async () => {
      const original = process.env.ADMIN_SECRET;
      process.env.ADMIN_SECRET = 'correct-key';
      const res = await request(makeApp())
        .post('/users/admin/verify')
        .set('x-admin-secret', 'wrong-key')
        .send({});
      expect([403, 429]).toContain(res.status);
      process.env.ADMIN_SECRET = original;
    });

    it('rejects when valid secret but missing user', async () => {
      const original = process.env.ADMIN_SECRET;
      process.env.ADMIN_SECRET = 'matching-key';
      const res = await request(makeApp())
        .post('/users/admin/verify')
        .set('x-admin-secret', 'matching-key')
        .send({ verified: true });
      expect([400, 429]).toContain(res.status);
      process.env.ADMIN_SECRET = original;
    });

    it('rejects when verified not boolean', async () => {
      const original = process.env.ADMIN_SECRET;
      process.env.ADMIN_SECRET = 'matching-key';
      const res = await request(makeApp())
        .post('/users/admin/verify')
        .set('x-admin-secret', 'matching-key')
        .send({ user: 'a@b.com', verified: 'true' });
      expect([400, 429]).toContain(res.status);
      process.env.ADMIN_SECRET = original;
    });

    it('rejects when role not string', async () => {
      const original = process.env.ADMIN_SECRET;
      process.env.ADMIN_SECRET = 'matching-key';
      const res = await request(makeApp())
        .post('/users/admin/verify')
        .set('x-admin-secret', 'matching-key')
        .send({ user: 'a@b.com', verified: true, role: 123 });
      expect([400, 429]).toContain(res.status);
      process.env.ADMIN_SECRET = original;
    });

    it('succeeds with valid secret + body', async () => {
      const original = process.env.ADMIN_SECRET;
      process.env.ADMIN_SECRET = 'matching-key';
      const res = await request(makeApp())
        .post('/users/admin/verify')
        .set('x-admin-secret', 'matching-key')
        .send({ user: 'a@b.com', verified: true });
      expect([200, 429]).toContain(res.status);
      process.env.ADMIN_SECRET = original;
    });
  });

  describe('error propagation', () => {
    it('GET /users/me 500 on service error', async () => {
      mockUserService.getProfile.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).get('/users/me');
      expect(res.status).toBe(500);
    });

    it('PUT /users/me/availability 500 on error', async () => {
      mockUserService.updateAvailability.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp())
        .put('/users/me/availability')
        .send({ availableFor: ['text'] });
      expect(res.status).toBe(500);
    });

    it('POST /users/:id/follow 500 on error', async () => {
      mockFollowService.followUser.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).post('/users/u-2/follow');
      expect(res.status).toBe(500);
    });

    it('DELETE /users/:id/follow 500 on error', async () => {
      mockFollowService.unfollowUser.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).delete('/users/u-2/follow');
      expect(res.status).toBe(500);
    });

    it('POST /users/:id/like 500 on error', async () => {
      mockLikeService.likeUser.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).post('/users/u-2/like');
      expect(res.status).toBe(500);
    });

    it('POST /users/me/contacts/sync 500 on error', async () => {
      mockUserService.syncContacts.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp())
        .post('/users/me/contacts/sync')
        .send({ hashes: ['x'.repeat(32)] });
      expect(res.status).toBe(500);
    });
  });
});
