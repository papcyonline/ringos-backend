import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockIsUserInCall } = vi.hoisted(() => ({
  mockPrisma: {
    spotlightLog: { create: vi.fn(), update: vi.fn() },
    block: { findMany: vi.fn(), findFirst: vi.fn() },
    like: { findMany: vi.fn(), groupBy: vi.fn() },
    follow: { findMany: vi.fn(), groupBy: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockIsUserInCall: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../call/call.gateway', () => ({
  isUserInCall: mockIsUserInCall,
}));

import {
  createSpotlightLog,
  endSpotlightLog,
  getBlockedUserIds,
  buildBroadcasterList,
  findOrCreateConversation,
  areUsersBlocked,
} from '../spotlight.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsUserInCall.mockResolvedValue(false);
});

describe('spotlight.service', () => {
  describe('createSpotlightLog', () => {
    it('creates and returns id', async () => {
      mockPrisma.spotlightLog.create.mockResolvedValue({ id: 'log-1' });
      const id = await createSpotlightLog('u-1', 'note');
      expect(id).toBe('log-1');
      expect(mockPrisma.spotlightLog.create).toHaveBeenCalledWith({
        data: { broadcasterId: 'u-1', note: 'note' },
      });
    });
  });

  describe('endSpotlightLog', () => {
    it('updates with stats', async () => {
      mockPrisma.spotlightLog.update.mockResolvedValue({});
      await endSpotlightLog('log-1', { peakViewers: 5, totalViewers: 10, connectCount: 7 });
      expect(mockPrisma.spotlightLog.update).toHaveBeenCalled();
    });

    it('swallows errors silently', async () => {
      mockPrisma.spotlightLog.update.mockRejectedValue(new Error('db'));
      await expect(
        endSpotlightLog('log-1', { peakViewers: 0, totalViewers: 0, connectCount: 0 }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getBlockedUserIds', () => {
    it('returns set of users blocked in either direction', async () => {
      mockPrisma.block.findMany.mockResolvedValue([
        { blockerId: 'u-1', blockedId: 'u-2' },
        { blockerId: 'u-3', blockedId: 'u-1' },
      ]);
      const set = await getBlockedUserIds('u-1');
      expect(set.has('u-2')).toBe(true);
      expect(set.has('u-3')).toBe(true);
      expect(set.size).toBe(2);
    });

    it('returns empty set when no blocks', async () => {
      mockPrisma.block.findMany.mockResolvedValue([]);
      const set = await getBlockedUserIds('u-1');
      expect(set.size).toBe(0);
    });
  });

  describe('buildBroadcasterList', () => {
    it('filters self, blocked, and in-call broadcasters', async () => {
      const live = new Map<string, any>([
        ['u-1', { displayName: 'Me', avatarUrl: null, bio: null, note: null, isVerified: false, location: null, startedAt: new Date(), viewerCount: 0 }],
        ['u-2', { displayName: 'B', avatarUrl: null, bio: null, note: null, isVerified: false, location: null, startedAt: new Date(), viewerCount: 1 }],
        ['u-3', { displayName: 'C', avatarUrl: null, bio: null, note: null, isVerified: false, location: null, startedAt: new Date(), viewerCount: 2 }],
        ['u-4', { displayName: 'D', avatarUrl: null, bio: null, note: null, isVerified: false, location: null, startedAt: new Date(), viewerCount: 3 }],
      ]);
      const blocked = new Set(['u-3']);
      // u-2 in call (idx 0), u-4 not in call (idx 1)  -- after self/blocked filtering, candidate list is ['u-2','u-4']
      mockIsUserInCall.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      mockPrisma.like.findMany.mockResolvedValue([{ likedId: 'u-4' }]);
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.groupBy.mockResolvedValue([{ followingId: 'u-4', _count: 5 }]);
      mockPrisma.like.groupBy.mockResolvedValue([{ likedId: 'u-4', _count: 2 }]);

      const list = await buildBroadcasterList(live, 'u-1', blocked);
      expect(list).toHaveLength(1);
      expect(list[0].userId).toBe('u-4');
      expect(list[0].isLiked).toBe(true);
      expect(list[0].followerCount).toBe(5);
      expect(list[0].likeCount).toBe(2);
    });

    it('returns empty list when nobody available', async () => {
      const live = new Map();
      mockPrisma.like.findMany.mockResolvedValue([]);
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.groupBy.mockResolvedValue([]);
      mockPrisma.like.groupBy.mockResolvedValue([]);
      const list = await buildBroadcasterList(live, 'u-1', new Set());
      expect(list).toEqual([]);
    });
  });

  describe('findOrCreateConversation', () => {
    it('returns existing 1-on-1 conversation', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          conversation: {
            findFirst: vi.fn().mockResolvedValue({
              id: 'c-1',
              participants: [{ userId: 'u-1' }, { userId: 'u-2' }],
            }),
            create: vi.fn(),
          },
        };
        return fn(tx);
      });
      const id = await findOrCreateConversation('u-1', 'u-2');
      expect(id).toBe('c-1');
    });

    it('creates new conversation when none exists', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          conversation: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'c-new' }),
          },
        };
        return fn(tx);
      });
      const id = await findOrCreateConversation('u-1', 'u-2');
      expect(id).toBe('c-new');
    });

    it('creates new when existing has wrong participant count (group)', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          conversation: {
            findFirst: vi.fn().mockResolvedValue({ id: 'c-grp', participants: [{ userId: 'u-1' }, { userId: 'u-2' }, { userId: 'u-3' }] }),
            create: vi.fn().mockResolvedValue({ id: 'c-new' }),
          },
        };
        return fn(tx);
      });
      const id = await findOrCreateConversation('u-1', 'u-2');
      expect(id).toBe('c-new');
    });
  });

  describe('areUsersBlocked', () => {
    it('returns true when block exists', async () => {
      mockPrisma.block.findFirst.mockResolvedValue({ id: 'b-1' });
      const res = await areUsersBlocked('u-1', 'u-2');
      expect(res).toBe(true);
    });

    it('returns false when no block', async () => {
      mockPrisma.block.findFirst.mockResolvedValue(null);
      const res = await areUsersBlocked('u-1', 'u-2');
      expect(res).toBe(false);
    });
  });
});
