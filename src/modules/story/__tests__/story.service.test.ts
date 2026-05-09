import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted so they're in scope before imports are wired up) ────
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    story: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    storyView: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    storyReaction: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    storySlide: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../shared/cloudinary.service', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../chat/chat.service', () => ({
  getOrCreateDirectConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
  sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
}));
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../../shared/usage.service', () => ({ isPro: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../shared/upload', () => ({
  fileToStoryImageUrl: vi.fn(),
  fileToStoryVideoUrl: vi.fn(),
}));
vi.mock('../story.notify', () => ({
  notifyFollowersOfNewStory: vi.fn(),
  notifyStoryOwnerOfView: vi.fn(),
}));

// ── Import after mocks are registered ──────────────────────────────────
import {
  likeStory,
  reactToStory,
  clearStoryReaction,
  replyToStory,
  bumpStoryShare,
  bumpStoryDownload,
  bumpStoryRepost,
  deleteSlide,
} from '../story.service';
import { sendMessage } from '../../chat/chat.service';

describe('story.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── likeStory ────────────────────────────────────────────────────────
  describe('likeStory', () => {
    it('first-time like: creates StoryView, upserts ❤️ reaction, increments likeCount', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue(null);
      mockPrisma.storyView.findUnique.mockResolvedValue(null);

      await likeStory('story-1', 'user-1', true);

      expect(mockPrisma.storyView.create).toHaveBeenCalledWith({
        data: { storyId: 'story-1', viewerId: 'user-1', liked: true },
      });
      expect(mockPrisma.storyReaction.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storyId_userId: { storyId: 'story-1', userId: 'user-1' } },
          create: { storyId: 'story-1', userId: 'user-1', emoji: '❤️' },
        }),
      );
      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 'story-1' },
        data: { likeCount: { increment: 1 } },
      });
    });

    it('unlike when not previously liked: no likeCount write (stays at 0)', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue(null);
      mockPrisma.storyView.findUnique.mockResolvedValue({ id: 'v1', liked: false });

      await likeStory('story-1', 'user-1', false);

      expect(mockPrisma.storyReaction.deleteMany).toHaveBeenCalled();
      // wasLiked === false === liked → no transition → no story.update for likeCount
      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });

    it('unlike when previously liked: decrements likeCount', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '❤️' });
      mockPrisma.storyView.findUnique.mockResolvedValue({ id: 'v1', liked: true });

      await likeStory('story-1', 'user-1', false);

      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 'story-1' },
        data: { likeCount: { increment: -1 } },
      });
    });

    it('idempotent like (already liked): does NOT double-increment', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '❤️' });
      mockPrisma.storyView.findUnique.mockResolvedValue({ id: 'v1', liked: true });

      await likeStory('story-1', 'user-1', true);

      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });
  });

  // ── reactToStory ────────────────────────────────────────────────────
  describe('reactToStory', () => {
    beforeEach(() => {
      mockPrisma.story.findUnique.mockResolvedValue({ id: 's1', userId: 'owner-1' });
    });

    it('rejects unknown emoji', async () => {
      await expect(reactToStory('s1', 'u1', '🥑')).rejects.toThrow(/Invalid reaction emoji/);
    });

    it('returns null when story does not exist', async () => {
      mockPrisma.story.findUnique.mockResolvedValueOnce(null);
      mockPrisma.storyReaction.findUnique.mockResolvedValue(null);
      const res = await reactToStory('missing', 'u1', '❤️');
      expect(res).toBeNull();
    });

    it('first ❤️ reaction: increments likeCount once', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue(null);

      await reactToStory('s1', 'u1', '❤️');

      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { likeCount: { increment: 1 } },
      });
    });

    it('switching from ❤️ to non-❤️: decrements likeCount', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '❤️' });

      await reactToStory('s1', 'u1', '😂');

      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { likeCount: { increment: -1 } },
      });
    });

    it('switching from non-❤️ to ❤️: increments likeCount', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '😂' });

      await reactToStory('s1', 'u1', '❤️');

      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { likeCount: { increment: 1 } },
      });
    });

    it('switching between two non-❤️ emojis: no likeCount write', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '😂' });

      await reactToStory('s1', 'u1', '😢');

      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });

    it('persists the new reaction emoji and mirrors ❤️ to legacy view.liked', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue(null);

      await reactToStory('s1', 'u1', '❤️');

      expect(mockPrisma.storyReaction.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: { storyId: 's1', userId: 'u1', emoji: '❤️' },
          update: { emoji: '❤️' },
        }),
      );
      expect(mockPrisma.storyView.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: { storyId: 's1', viewerId: 'u1', liked: true },
          update: { liked: true },
        }),
      );
    });
  });

  // ── clearStoryReaction ─────────────────────────────────────────────
  describe('clearStoryReaction', () => {
    it('decrements likeCount when previous reaction was ❤️', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '❤️' });

      await clearStoryReaction('s1', 'u1');

      expect(mockPrisma.storyReaction.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { likeCount: { decrement: 1 } },
      });
    });

    it('does NOT decrement when previous reaction was something else', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue({ emoji: '😂' });

      await clearStoryReaction('s1', 'u1');

      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });

    it('does nothing extra when there was no previous reaction', async () => {
      mockPrisma.storyReaction.findUnique.mockResolvedValue(null);

      await clearStoryReaction('s1', 'u1');

      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });
  });

  // ── replyToStory ────────────────────────────────────────────────────
  describe('replyToStory', () => {
    beforeEach(() => {
      mockPrisma.story.findUnique.mockResolvedValue({
        id: 's1',
        userId: 'owner-1',
        slides: [{ id: 'slide-1', type: 'IMAGE', mediaUrl: 'u', thumbnailUrl: null }],
      });
    });

    it('rejects empty / whitespace-only text', async () => {
      await expect(replyToStory('s1', 'u1', '  ')).rejects.toThrow(/Reply text/);
      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });

    it('returns null when story does not exist', async () => {
      mockPrisma.story.findUnique.mockResolvedValueOnce(null);
      const res = await replyToStory('missing', 'u1', 'hi');
      expect(res).toBeNull();
    });

    it('rejects replying to your own story', async () => {
      mockPrisma.story.findUnique.mockResolvedValueOnce({
        id: 's1',
        userId: 'u1', // same as sender
        slides: [],
      });
      await expect(replyToStory('s1', 'u1', 'hi')).rejects.toThrow(/own story/);
    });

    it('sends message + bumps commentCount on success', async () => {
      const res = await replyToStory('s1', 'sender-1', 'nice!');

      expect(sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'sender-1',
        'nice!',
        expect.objectContaining({
          metadata: expect.objectContaining({
            storyContext: expect.objectContaining({
              storyId: 's1',
              ownerId: 'owner-1',
            }),
          }),
        }),
      );
      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { commentCount: { increment: 1 } },
      });
      expect(res).toEqual({ conversationId: 'conv-1', messageId: 'msg-1' });
    });
  });

  // ── bumpStoryShare / Download / Repost ────────────────────────────
  describe('bump counters', () => {
    it.each<[string, (id: string) => Promise<boolean>, string]>([
      ['share', bumpStoryShare, 'shareCount'],
      ['download', bumpStoryDownload, 'downloadCount'],
      ['repost', bumpStoryRepost, 'repostCount'],
    ])('bumpStory%s increments %s', async (_label, fn, field) => {
      mockPrisma.story.findUnique.mockResolvedValue({ id: 's1' });

      const ok = await fn('s1');

      expect(ok).toBe(true);
      expect(mockPrisma.story.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { [field]: { increment: 1 } },
      });
    });

    it('returns false (and does not update) when story is missing', async () => {
      mockPrisma.story.findUnique.mockResolvedValue(null);

      expect(await bumpStoryShare('missing')).toBe(false);
      expect(await bumpStoryDownload('missing')).toBe(false);
      expect(await bumpStoryRepost('missing')).toBe(false);
      expect(mockPrisma.story.update).not.toHaveBeenCalled();
    });
  });

  // ── deleteSlide ─────────────────────────────────────────────────────
  describe('deleteSlide', () => {
    it('returns not_found for missing slide', async () => {
      mockPrisma.storySlide.findUnique.mockResolvedValue(null);
      const res = await deleteSlide('missing', 'u1');
      expect(res).toEqual({ deleted: false, reason: 'not_found' });
    });

    it('returns not_owner when caller is not the story owner', async () => {
      mockPrisma.storySlide.findUnique.mockResolvedValue({
        id: 'slide-1',
        cloudinaryId: null,
        type: 'IMAGE',
        story: { id: 's1', userId: 'OTHER', _count: { slides: 3 } },
        storyId: 's1',
      });
      const res = await deleteSlide('slide-1', 'u1');
      expect(res).toEqual({ deleted: false, reason: 'not_owner' });
    });

    it('last-slide path: deletes the whole story and returns storyDeleted: true with storyId', async () => {
      mockPrisma.storySlide.findUnique.mockResolvedValue({
        id: 'slide-1',
        cloudinaryId: null,
        type: 'IMAGE',
        storyId: 's1',
        story: { id: 's1', userId: 'u1', _count: { slides: 1 } },
      });

      const res = await deleteSlide('slide-1', 'u1');

      expect(mockPrisma.story.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
      expect(mockPrisma.storySlide.delete).not.toHaveBeenCalled();
      expect(res).toEqual({ deleted: true, storyDeleted: true, storyId: 's1' });
    });

    it('partial delete: removes the slide, reorders remaining, returns storyDeleted: false', async () => {
      mockPrisma.storySlide.findUnique.mockResolvedValue({
        id: 'slide-2',
        cloudinaryId: null,
        type: 'IMAGE',
        storyId: 's1',
        story: { id: 's1', userId: 'u1', _count: { slides: 3 } },
      });
      mockPrisma.storySlide.findMany.mockResolvedValue([
        { id: 'slide-1' },
        { id: 'slide-3' },
      ]);

      const res = await deleteSlide('slide-2', 'u1');

      expect(mockPrisma.storySlide.delete).toHaveBeenCalledWith({ where: { id: 'slide-2' } });
      expect(mockPrisma.storySlide.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.story.delete).not.toHaveBeenCalled();
      expect(res).toEqual({ deleted: true, storyDeleted: false, storyId: 's1' });
    });
  });
});
