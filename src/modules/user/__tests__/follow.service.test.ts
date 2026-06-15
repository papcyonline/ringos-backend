import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockInvalidate } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    follow: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
  mockInvalidate: vi.fn(),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../story/story.service', () => ({
  invalidateFeedCache: mockInvalidate,
}));

import {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  isFollowing,
  getFollowerCount,
  getFollowingCount,
} from '../follow.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('follow.service', () => {
  describe('followUser', () => {
    it('throws when self-follow', async () => {
      await expect(followUser('u-1', 'u-1')).rejects.toThrow(/yourself/);
    });

    it('throws when target not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(followUser('u-1', 'u-2')).rejects.toThrow(/not found/i);
    });

    it('throws when already following', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
      mockPrisma.follow.findUnique.mockResolvedValue({ id: 'f-1' });
      await expect(followUser('u-1', 'u-2')).rejects.toThrow(/already/i);
    });

    it('follows successfully and invalidates cache', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
      mockPrisma.follow.findUnique.mockResolvedValue(null);
      mockPrisma.follow.create.mockResolvedValue({ id: 'f-1', followerId: 'u-1', followingId: 'u-2' });
      const res = await followUser('u-1', 'u-2');
      expect(res.id).toBe('f-1');
      expect(mockInvalidate).toHaveBeenCalledWith('u-1');
    });
  });

  describe('unfollowUser', () => {
    it('throws when not following', async () => {
      mockPrisma.follow.findUnique.mockResolvedValue(null);
      await expect(unfollowUser('u-1', 'u-2')).rejects.toThrow(/Not following/);
    });

    it('unfollows and invalidates cache', async () => {
      mockPrisma.follow.findUnique.mockResolvedValue({ id: 'f-1' });
      mockPrisma.follow.delete.mockResolvedValue({});
      await unfollowUser('u-1', 'u-2');
      expect(mockPrisma.follow.delete).toHaveBeenCalled();
      expect(mockInvalidate).toHaveBeenCalledWith('u-1');
    });
  });

  describe('getFollowers / getFollowing', () => {
    it('getFollowers queries by followingId', async () => {
      mockPrisma.follow.findMany.mockResolvedValue([]);
      await getFollowers('u-1', 'viewer-1');
      expect(mockPrisma.follow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { followingId: 'u-1' } }),
      );
    });

    it('getFollowing queries by followerId', async () => {
      mockPrisma.follow.findMany.mockResolvedValue([]);
      await getFollowing('u-1', 'viewer-1');
      expect(mockPrisma.follow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { followerId: 'u-1' } }),
      );
    });
  });

  describe('isFollowing', () => {
    it('returns true when found', async () => {
      mockPrisma.follow.findUnique.mockResolvedValue({ id: 'f-1' });
      expect(await isFollowing('u-1', 'u-2')).toBe(true);
    });

    it('returns false when not found', async () => {
      mockPrisma.follow.findUnique.mockResolvedValue(null);
      expect(await isFollowing('u-1', 'u-2')).toBe(false);
    });
  });

  describe('counts', () => {
    it('getFollowerCount', async () => {
      mockPrisma.follow.count.mockResolvedValue(7);
      expect(await getFollowerCount('u-1')).toBe(7);
    });

    it('getFollowingCount', async () => {
      mockPrisma.follow.count.mockResolvedValue(3);
      expect(await getFollowingCount('u-1')).toBe(3);
    });
  });
});
