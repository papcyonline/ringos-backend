import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockCreateNotification, mockSendData } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    follow: { findMany: vi.fn() },
    storyMute: { findMany: vi.fn() },
  },
  mockCreateNotification: vi.fn().mockResolvedValue(null),
  mockSendData: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../notification/notification.service', () => ({
  createNotification: mockCreateNotification,
  sendDataPushToUser: mockSendData,
}));

import { notifyStoryOwnerOfView, notifyFollowersOfNewStory } from '../story.notify';

beforeEach(() => {
  vi.clearAllMocks();
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
    it('returns early when author missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await notifyFollowersOfNewStory('s-1', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('returns early when author has no followers', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A', avatarUrl: null });
      mockPrisma.follow.findMany.mockResolvedValue([]);
      await notifyFollowersOfNewStory('s-1', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('skips muted followers and notifies the rest', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: 'https://x' });
      mockPrisma.follow.findMany.mockResolvedValue([
        { followerId: 'u-2' },
        { followerId: 'u-3' },
        { followerId: 'u-4' },
      ]);
      mockPrisma.storyMute.findMany.mockResolvedValue([{ muterId: 'u-3' }]);
      await notifyFollowersOfNewStory('s-1', 'u-1');

      // 2 targets × 2 calls each (createNotification + sendDataPushToUser)
      expect(mockCreateNotification).toHaveBeenCalledTimes(2);
      expect(mockSendData).toHaveBeenCalledTimes(2);
    });

    it('returns early when all followers are muted', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A', avatarUrl: null });
      mockPrisma.follow.findMany.mockResolvedValue([{ followerId: 'u-2' }]);
      mockPrisma.storyMute.findMany.mockResolvedValue([{ muterId: 'u-2' }]);
      await notifyFollowersOfNewStory('s-1', 'u-1');
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });
  });
});
