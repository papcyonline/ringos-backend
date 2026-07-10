import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockCreateNotification, mockSendData, mockGetBlockedUserIds } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    follow: { findMany: vi.fn() },
    storyMute: { findMany: vi.fn() },
    storyHide: { findMany: vi.fn() },
    story: { count: vi.fn() },
  },
  mockCreateNotification: vi.fn().mockResolvedValue(null),
  mockSendData: vi.fn().mockResolvedValue(null),
  mockGetBlockedUserIds: vi.fn(),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../notification/notification.service', () => ({
  createNotification: mockCreateNotification,
  sendDataPushToUser: mockSendData,
}));
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: mockGetBlockedUserIds,
}));

import { notifyStoryOwnerOfView, notifyFollowersOfNewStory } from '../story.notify';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: author has no other active story, so the throttle lets the
  // fan-out through. Tests that exercise the throttle override this.
  mockPrisma.story.count.mockResolvedValue(0);
  // Default: no hides, no blocks.
  mockPrisma.storyHide.findMany.mockResolvedValue([]);
  mockGetBlockedUserIds.mockResolvedValue(new Set());
});

describe('story.notify', () => {
  describe('notifyStoryOwnerOfView', () => {
    it('is a no-op for self-views', async () => {
      await expect(notifyStoryOwnerOfView('s-1', 'u-1', 'u-1')).resolves.toBeUndefined();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('is a no-op for other-views (legacy stub)', async () => {
      await expect(notifyStoryOwnerOfView('s-1', 'u-1', 'u-2')).resolves.toBeUndefined();
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });
  });

  describe('notifyFollowersOfNewStory', () => {
    // follow.findMany is called twice: followers (where.followingId = author)
    // and following (where.followerId = author). Route by the where clause so
    // the tests don't depend on call order.
    function mockGraph(followers: string[], followedByAuthor: string[]) {
      mockPrisma.follow.findMany.mockImplementation(({ where }: any) => {
        if (where.followingId) return Promise.resolve(followers.map((id) => ({ followerId: id })));
        if (where.followerId) return Promise.resolve(followedByAuthor.map((id) => ({ followingId: id })));
        return Promise.resolve([]);
      });
    }

    it('returns early when author missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await notifyFollowersOfNewStory('s-1', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('skips the whole fan-out when the author already has an active story', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A', avatarUrl: null });
      mockPrisma.story.count.mockResolvedValue(1); // a prior live story exists
      mockGraph(['u-2'], ['u-3']);
      mockPrisma.storyMute.findMany.mockResolvedValue([]);
      await notifyFollowersOfNewStory('s-2', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
      // Throttle short-circuits before the follow graph is queried.
      expect(mockPrisma.follow.findMany).not.toHaveBeenCalled();
    });

    it('returns early when there is no audience', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A', avatarUrl: null });
      mockGraph([], []);
      mockPrisma.storyMute.findMany.mockResolvedValue([]);
      await notifyFollowersOfNewStory('s-1', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('notifies followers (#1) and followed users (#2) with distinct copy, deduping mutuals', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: 'https://x' });
      // u-2 follows Alice (#1). Alice follows u-3 (#2). u-4 is mutual → #1 only.
      mockGraph(['u-2', 'u-4'], ['u-3', 'u-4']);
      mockPrisma.storyMute.findMany.mockResolvedValue([]);
      await notifyFollowersOfNewStory('s-1', 'u-1');

      // 3 distinct recipients (u-2, u-4, u-3) × (createNotification + push).
      expect(mockCreateNotification).toHaveBeenCalledTimes(3);
      expect(mockSendData).toHaveBeenCalledTimes(3);
      const byUser = Object.fromEntries(
        mockCreateNotification.mock.calls.map((c: any) => [c[0].userId, c[0].body]),
      );
      expect(byUser['u-2']).toBe('posted a new story');
      expect(byUser['u-4']).toBe('posted a new story');
      expect(byUser['u-3']).toBe('who follows you posted a story');
      // u-4 (mutual) is pinged exactly once.
      expect(
        mockCreateNotification.mock.calls.filter((c: any) => c[0].userId === 'u-4'),
      ).toHaveLength(1);
    });

    it('excludes muted users from both audiences', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: null });
      mockGraph(['u-2'], ['u-3']);
      mockPrisma.storyMute.findMany.mockResolvedValue([{ muterId: 'u-2' }, { muterId: 'u-3' }]);
      await notifyFollowersOfNewStory('s-1', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('excludes blocked users and users the author hid their story from', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: null });
      // u-2 follows Alice but is blocked; u-3 is hidden-from; u-5 is clean.
      mockGraph(['u-2', 'u-5'], ['u-3']);
      mockPrisma.storyMute.findMany.mockResolvedValue([]);
      mockPrisma.storyHide.findMany.mockResolvedValue([{ hiddenUserId: 'u-3' }]);
      mockGetBlockedUserIds.mockResolvedValue(new Set(['u-2']));
      await notifyFollowersOfNewStory('s-1', 'u-1');

      // Only u-5 survives both filters.
      expect(mockCreateNotification).toHaveBeenCalledTimes(1);
      expect(mockCreateNotification.mock.calls[0][0].userId).toBe('u-5');
    });

    it('a permanent prior story does NOT suppress the announcement (throttle counts ephemeral only)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: null });
      // count is filtered to isPermanent:false in the query, so the mock returns
      // 0 here — assert the query asked for ephemeral, still-live stories only.
      mockPrisma.story.count.mockResolvedValue(0);
      mockGraph(['u-2'], []);
      mockPrisma.storyMute.findMany.mockResolvedValue([]);
      await notifyFollowersOfNewStory('s-1', 'u-1');

      expect(mockCreateNotification).toHaveBeenCalledTimes(1);
      const countWhere = mockPrisma.story.count.mock.calls[0][0].where;
      expect(countWhere.isPermanent).toBe(false);
      expect(countWhere.expiresAt).toEqual({ gt: expect.any(Date) });
    });
  });
});
