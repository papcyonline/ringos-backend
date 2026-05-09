import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetBlocked, mockFindBestMatch } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    matchRequest: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    conversation: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockGetBlocked: vi.fn().mockResolvedValue(new Set<string>()),
  mockFindBestMatch: vi.fn(),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../matching.algorithm', () => ({
  findBestMatch: mockFindBestMatch,
  calculateMatchScore: vi.fn(),
}));
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: mockGetBlocked,
}));

import {
  createMatchRequest,
  attemptMatch,
  cancelMatchRequest,
  getActiveRequest,
} from '../matching.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBlocked.mockResolvedValue(new Set<string>());
});

describe('matching.service', () => {
  describe('createMatchRequest', () => {
    it('throws when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(createMatchRequest('u-1', { intent: 'CHAT' } as any)).rejects.toThrow(/not found/i);
    });

    it('throws when banned permanently', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1', moderation: { banStatus: 'PERMANENT_BAN' }, preference: null,
      });
      await expect(createMatchRequest('u-1', { intent: 'CHAT' } as any)).rejects.toThrow(/banned/);
    });

    it('throws when temp-banned and not yet expired', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        moderation: { banStatus: 'TEMP_BAN', banExpiresAt: new Date(Date.now() + 100000) },
        preference: null,
      });
      await expect(createMatchRequest('u-1', { intent: 'CHAT' } as any)).rejects.toThrow(/banned/);
    });

    it('allows when temp ban expired', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        moderation: { banStatus: 'TEMP_BAN', banExpiresAt: new Date(Date.now() - 100000) },
        preference: null,
      });
      mockPrisma.matchRequest.findFirst.mockResolvedValue(null);
      mockPrisma.matchRequest.create.mockResolvedValue({
        id: 'r-1', userId: 'u-1', intent: 'CHAT', mood: 'NEUTRAL', language: 'en',
        timezone: 'UTC', topics: [],
      });
      mockPrisma.matchRequest.findMany.mockResolvedValue([]);
      const res = await createMatchRequest('u-1', { intent: 'CHAT' } as any);
      expect(res.request.id).toBe('r-1');
    });

    it('throws when active request exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', moderation: null, preference: null });
      mockPrisma.matchRequest.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(createMatchRequest('u-1', { intent: 'CHAT' } as any)).rejects.toThrow(/already/);
    });

    it('creates request and immediately attempts match (none found)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        moderation: null,
        preference: { mood: 'HAPPY', language: 'fr', timezone: 'UTC', topics: ['x'] },
      });
      mockPrisma.matchRequest.findFirst.mockResolvedValue(null);
      mockPrisma.matchRequest.create.mockResolvedValue({
        id: 'r-1', userId: 'u-1', intent: 'CHAT', mood: 'HAPPY', language: 'fr',
        timezone: 'UTC', topics: ['x'],
      });
      mockPrisma.matchRequest.findMany.mockResolvedValue([]);
      const res = await createMatchRequest('u-1', { intent: 'CHAT', topics: ['x'] } as any);
      expect(res.matchResult).toBeNull();
    });
  });

  describe('attemptMatch', () => {
    const baseReq = {
      id: 'r-1', userId: 'u-1', intent: 'CHAT', mood: 'NEUTRAL',
      language: 'en', timezone: 'UTC', topics: [],
    };

    it('returns null when no candidates', async () => {
      mockPrisma.matchRequest.findMany.mockResolvedValue([]);
      const res = await attemptMatch(baseReq);
      expect(res).toBeNull();
    });

    it('returns null when no match above threshold', async () => {
      mockPrisma.matchRequest.findMany.mockResolvedValue([
        { id: 'r-2', userId: 'u-2', intent: 'CHAT', mood: 'SAD', language: 'es', timezone: 'UTC', topics: [] },
      ]);
      mockFindBestMatch.mockReturnValue(null);
      const res = await attemptMatch(baseReq);
      expect(res).toBeNull();
    });

    it('creates conversation when match found', async () => {
      mockPrisma.matchRequest.findMany.mockResolvedValue([
        { id: 'r-2', userId: 'u-2', intent: 'CHAT', mood: 'NEUTRAL', language: 'en', timezone: 'UTC', topics: [] },
      ]);
      mockFindBestMatch.mockReturnValue({
        match: { id: 'r-2', userId: 'u-2' },
        score: 0.85,
      });
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          matchRequest: { update: vi.fn() },
          conversation: { create: vi.fn().mockResolvedValue({ id: 'c-1', participants: [] }) },
        };
        return fn(tx);
      });
      const res = await attemptMatch(baseReq);
      expect(res).not.toBeNull();
      expect(res?.conversation.id).toBe('c-1');
      expect(res?.score).toBe(0.85);
    });

    it('excludes blocked users from candidate query', async () => {
      mockGetBlocked.mockResolvedValue(new Set(['blk-1', 'blk-2']));
      mockPrisma.matchRequest.findMany.mockResolvedValue([]);
      await attemptMatch(baseReq);
      expect(mockPrisma.matchRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: expect.objectContaining({ notIn: expect.arrayContaining(['u-1', 'blk-1', 'blk-2']) }),
          }),
        }),
      );
    });
  });

  describe('cancelMatchRequest', () => {
    it('throws when not found', async () => {
      mockPrisma.matchRequest.findUnique.mockResolvedValue(null);
      await expect(cancelMatchRequest('r-1', 'u-1')).rejects.toThrow(/not found/i);
    });

    it('throws when belongs to another user', async () => {
      mockPrisma.matchRequest.findUnique.mockResolvedValue({ id: 'r-1', userId: 'other', status: 'WAITING' });
      await expect(cancelMatchRequest('r-1', 'u-1')).rejects.toThrow(/own/);
    });

    it('throws when not in WAITING', async () => {
      mockPrisma.matchRequest.findUnique.mockResolvedValue({ id: 'r-1', userId: 'u-1', status: 'MATCHED' });
      await expect(cancelMatchRequest('r-1', 'u-1')).rejects.toThrow(/waiting/i);
    });

    it('cancels successfully', async () => {
      mockPrisma.matchRequest.findUnique.mockResolvedValue({ id: 'r-1', userId: 'u-1', status: 'WAITING' });
      mockPrisma.matchRequest.update.mockResolvedValue({ id: 'r-1', status: 'CANCELLED' });
      const res = await cancelMatchRequest('r-1', 'u-1');
      expect(res.status).toBe('CANCELLED');
    });
  });

  describe('getActiveRequest', () => {
    it('returns the latest waiting request', async () => {
      mockPrisma.matchRequest.findFirst.mockResolvedValue({ id: 'r-1' });
      const res = await getActiveRequest('u-1');
      expect(res?.id).toBe('r-1');
    });

    it('returns null when none', async () => {
      mockPrisma.matchRequest.findFirst.mockResolvedValue(null);
      const res = await getActiveRequest('u-1');
      expect(res).toBeNull();
    });
  });
});
