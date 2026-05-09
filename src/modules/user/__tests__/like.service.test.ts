import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    like: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));

import {
  likeUser,
  unlikeUser,
  getLikeCount,
  isLikedBy,
} from '../like.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('like.service', () => {
  describe('likeUser', () => {
    it('throws on self-like', async () => {
      await expect(likeUser('u-1', 'u-1')).rejects.toThrow(/yourself/);
    });

    it('throws when target missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(likeUser('u-1', 'u-2')).rejects.toThrow(/not found/i);
    });

    it('throws when already liked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
      mockPrisma.like.findUnique.mockResolvedValue({ id: 'l-1' });
      await expect(likeUser('u-1', 'u-2')).rejects.toThrow(/Already/);
    });

    it('creates like', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
      mockPrisma.like.findUnique.mockResolvedValue(null);
      mockPrisma.like.create.mockResolvedValue({ id: 'l-1', likerId: 'u-1', likedId: 'u-2' });
      const res = await likeUser('u-1', 'u-2');
      expect(res.id).toBe('l-1');
    });
  });

  describe('unlikeUser', () => {
    it('throws when not liked', async () => {
      mockPrisma.like.findUnique.mockResolvedValue(null);
      await expect(unlikeUser('u-1', 'u-2')).rejects.toThrow(/Not liked/);
    });

    it('deletes like', async () => {
      mockPrisma.like.findUnique.mockResolvedValue({ id: 'l-1' });
      mockPrisma.like.delete.mockResolvedValue({});
      await unlikeUser('u-1', 'u-2');
      expect(mockPrisma.like.delete).toHaveBeenCalled();
    });
  });

  describe('getLikeCount', () => {
    it('returns count', async () => {
      mockPrisma.like.count.mockResolvedValue(4);
      expect(await getLikeCount('u-1')).toBe(4);
    });
  });

  describe('isLikedBy', () => {
    it('returns true when found', async () => {
      mockPrisma.like.findUnique.mockResolvedValue({ id: 'l-1' });
      expect(await isLikedBy('u-1', 'u-2')).toBe(true);
    });

    it('returns false when not', async () => {
      mockPrisma.like.findUnique.mockResolvedValue(null);
      expect(await isLikedBy('u-1', 'u-2')).toBe(false);
    });
  });
});
