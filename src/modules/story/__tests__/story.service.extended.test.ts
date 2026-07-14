import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockChatService } = vi.hoisted(() => {
  const mockPrisma: any = {
    story: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    storySlide: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    storyView: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
      // Default to 1 (the view we just inserted) so the milestone
      // check is well below the smallest tier and is a no-op in
      // tests that don't care about milestones.
      count: vi.fn().mockResolvedValue(1),
    },
    storyMute: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    storyHide: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    storyReaction: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    follow: {
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    conversationParticipant: {
      findUnique: vi.fn(),
    },
  };
  const mockChatService: any = {
    getOrCreateDirectConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  };
  return { mockPrisma, mockChatService };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../shared/cloudinary.service', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../chat/chat.service', () => mockChatService);
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../../shared/usage.service', () => ({ isPro: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../shared/upload', () => ({
  fileToStoryImageUrl: vi.fn().mockResolvedValue({
    secureUrl: 'https://cdn/img.jpg', publicId: 'pid-img', thumbnailUrl: null,
  }),
  fileToStoryVideoUrl: vi.fn().mockResolvedValue({
    secureUrl: 'https://cdn/vid.mp4', publicId: 'pid-vid', thumbnailUrl: 'https://cdn/vid.jpg',
  }),
}));
vi.mock('../story.notify', () => ({
  notifyFollowersOfNewStory: vi.fn().mockResolvedValue(undefined),
  notifyStoryOwnerOfView: vi.fn().mockResolvedValue(undefined),
  checkStoryMilestone: vi.fn().mockResolvedValue(undefined),
}));

import {
  createStory,
  invalidateFeedCache,
  getStoryFeed,
  getFollowingFeed,
  getDiscoverFeed,
  muteUserStories,
  unmuteUserStories,
  markStoryViewed,
  getStoryViewers,
  replyToStory,
  bumpStoryShare,
  bumpStoryDownload,
  bumpStoryRepost,
  updateSlideCaption,
  deleteStory,
  cleanupExpiredStories,
} from '../story.service';
import { BadRequestError, ForbiddenError } from '../../../shared/errors';

const mockFile = (override: Partial<any> = {}) => ({
  buffer: Buffer.from('img'),
  originalname: 'photo.jpg',
  mimetype: 'image/jpeg',
  ...override,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateFeedCache(); // clear cache between tests
});

// ─── createStory ────────────────────────────────────────────────────

describe('createStory', () => {
  it('rejects channel story when caller is not channel admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(
      createStory('user-1', [mockFile()], undefined, { channelId: 'chan-1' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('uses 24h expiry for free user', async () => {
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });

    await createStory('user-1', [mockFile()]);

    const data = (mockPrisma.story.create.mock.calls[0][0] as any).data;
    const expiresAt: Date = data.expiresAt;
    const hoursFromNow = (expiresAt.getTime() - Date.now()) / 3600_000;
    expect(hoursFromNow).toBeGreaterThan(23);
    expect(hoursFromNow).toBeLessThan(25);
    expect(data.isPermanent).toBe(false);
  });

  it('uses 48h expiry for Pro user', async () => {
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(true);
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });

    await createStory('user-1', [mockFile()]);

    const data = (mockPrisma.story.create.mock.calls[0][0] as any).data;
    const hoursFromNow = (data.expiresAt.getTime() - Date.now()) / 3600_000;
    expect(hoursFromNow).toBeGreaterThan(47);
  });

  it('Pro user with isPermanent=true sets far-future expiry', async () => {
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(true);
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });

    await createStory('user-1', [mockFile()], undefined, { isPermanent: true });

    const data = (mockPrisma.story.create.mock.calls[0][0] as any).data;
    expect(data.isPermanent).toBe(true);
    expect(data.expiresAt.getFullYear()).toBeGreaterThan(2090);
  });

  it('non-Pro requesting permanent: ignored, falls back to 24h', async () => {
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });

    await createStory('user-1', [mockFile()], undefined, { isPermanent: true });

    const data = (mockPrisma.story.create.mock.calls[0][0] as any).data;
    expect(data.isPermanent).toBe(false);
  });

  it('uploads VIDEO slide via fileToStoryVideoUrl', async () => {
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });
    const upload = await import('../../../shared/upload');

    await createStory('user-1', [mockFile()], [{ type: 'VIDEO', position: 0 }]);

    expect(upload.fileToStoryVideoUrl).toHaveBeenCalled();
    expect(upload.fileToStoryImageUrl).not.toHaveBeenCalled();
  });

  it('packs music + videoEdits into slide metadata blob', async () => {
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });

    await createStory('user-1', [mockFile()], [{
      type: 'IMAGE',
      position: 0,
      music: { url: '/song.mp3', title: 'Song' },
      videoEdits: { speed: 1.5 },
    }]);

    const slidesData = (mockPrisma.story.create.mock.calls[0][0] as any).data.slides.create;
    expect(slidesData[0].metadata).toEqual({
      music: { url: '/song.mp3', title: 'Song' },
      videoEdits: { speed: 1.5 },
    });
  });

  it('skips notifyFollowers for channel stories', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });
    const notify = await import('../story.notify');

    await createStory('user-1', [mockFile()], undefined, { channelId: 'chan-1' });

    expect(notify.notifyFollowersOfNewStory).not.toHaveBeenCalled();
  });

  it('fires notifyFollowers for non-channel stories', async () => {
    mockPrisma.story.create.mockResolvedValue({ id: 's-1', slides: [] });
    const notify = await import('../story.notify');

    await createStory('user-1', [mockFile()]);

    expect(notify.notifyFollowersOfNewStory).toHaveBeenCalledWith('s-1', 'user-1');
  });
});

// ─── getStoryFeed ───────────────────────────────────────────────────

describe('getStoryFeed', () => {
  it('returns cached feed on hit', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.storyMute.findMany.mockResolvedValue([]);
    mockPrisma.story.findMany.mockResolvedValue([]);

    await getStoryFeed('user-1');
    mockPrisma.story.findMany.mockClear();
    await getStoryFeed('user-1');

    // Second call hits cache, no new DB query
    expect(mockPrisma.story.findMany).not.toHaveBeenCalled();
  });

  it('groups stories by user, marks isSelf and hasUnviewed correctly', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([{ followerId: 'friend-1' }]);
    mockPrisma.storyMute.findMany.mockResolvedValue([]);
    mockPrisma.story.findMany.mockResolvedValue([
      {
        id: 's-1', userId: 'user-1', createdAt: new Date(),
        slides: [], expiresAt: new Date(), views: [],
        reactions: [], _count: { views: 0 },
        likeCount: 0, commentCount: 0, repostCount: 0, shareCount: 0, downloadCount: 0,
        user: { id: 'user-1', displayName: 'Me', avatarUrl: null, isVerified: false, verifiedRole: null },
      },
      {
        id: 's-2', userId: 'friend-1', createdAt: new Date(),
        slides: [], expiresAt: new Date(), views: [],  // no view by user-1
        reactions: [], _count: { views: 0 },
        likeCount: 0, commentCount: 0, repostCount: 0, shareCount: 0, downloadCount: 0,
        user: { id: 'friend-1', displayName: 'F', avatarUrl: null, isVerified: false, verifiedRole: null },
      },
    ]);

    const res = await getStoryFeed('user-1');

    expect(res).toHaveLength(2);
    // Self always sorts first
    expect(res[0].isSelf).toBe(true);
    const friend = res.find((u: any) => u.userId === 'friend-1');
    expect(friend.hasUnviewed).toBe(true);
  });

  it('excludes muted users from audience', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([{ followerId: 'muted-friend' }]);
    mockPrisma.storyMute.findMany.mockResolvedValue([{ mutedUserId: 'muted-friend' }]);
    mockPrisma.story.findMany.mockResolvedValue([]);

    await getStoryFeed('user-1');

    const where = (mockPrisma.story.findMany.mock.calls[0][0] as any).where;
    expect(where.userId.in).not.toContain('muted-friend');
  });
});

// ─── getFollowingFeed ───────────────────────────────────────────────

describe('getFollowingFeed', () => {
  it('returns [] when user follows nobody', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.storyMute.findMany.mockResolvedValue([]);

    const res = await getFollowingFeed('user-1');

    expect(res).toEqual([]);
    expect(mockPrisma.story.findMany).not.toHaveBeenCalled();
  });

  it('queries stories of users I follow', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([{ followingId: 'creator-A' }]);
    mockPrisma.storyMute.findMany.mockResolvedValue([]);
    mockPrisma.story.findMany.mockResolvedValue([]);

    await getFollowingFeed('user-1');

    const where = (mockPrisma.story.findMany.mock.calls[0][0] as any).where;
    expect(where.userId.in).toEqual(['creator-A']);
  });
});

// ─── getDiscoverFeed ────────────────────────────────────────────────

describe('getDiscoverFeed', () => {
  it('excludes self, followers, following, blocked, and muted', async () => {
    const spotlight = await import('../../spotlight/spotlight.service');
    (spotlight.getBlockedUserIds as any).mockResolvedValueOnce(new Set(['blocked-x']));
    mockPrisma.follow.findMany
      .mockResolvedValueOnce([{ followingId: 'following-y' }])
      .mockResolvedValueOnce([{ followerId: 'follower-z' }]);
    mockPrisma.storyMute.findMany.mockResolvedValue([{ mutedUserId: 'muted-w' }]);
    mockPrisma.story.findMany.mockResolvedValue([]);

    await getDiscoverFeed('user-1');

    const where = (mockPrisma.story.findMany.mock.calls[0][0] as any).where;
    const notIn: string[] = where.userId.notIn;
    expect(notIn).toEqual(expect.arrayContaining(['user-1', 'following-y', 'follower-z', 'muted-w', 'blocked-x']));
    expect(where.visibility).toBe('PUBLIC');
  });
});

// ─── mute / unmute ──────────────────────────────────────────────────

describe('muteUserStories', () => {
  it('rejects self-mute', async () => {
    await expect(muteUserStories('user-1', 'user-1')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('upserts a storyMute row', async () => {
    mockPrisma.storyMute.upsert.mockResolvedValue({});
    await muteUserStories('user-1', 'user-2');
    expect(mockPrisma.storyMute.upsert).toHaveBeenCalled();
  });
});

describe('unmuteUserStories', () => {
  it('deletes mute row', async () => {
    await unmuteUserStories('user-1', 'user-2');
    expect(mockPrisma.storyMute.deleteMany).toHaveBeenCalledWith({
      where: { muterId: 'user-1', mutedUserId: 'user-2' },
    });
  });
});

// ─── markStoryViewed ────────────────────────────────────────────────

describe('markStoryViewed', () => {
  it('first view: notifies story owner', async () => {
    mockPrisma.storyView.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.story.findUnique.mockResolvedValue({ userId: 'owner-1' });
    const notify = await import('../story.notify');

    await markStoryViewed('s-1', 'viewer-1', false);

    expect(notify.notifyStoryOwnerOfView).toHaveBeenCalledWith('s-1', 'owner-1', 'viewer-1');
  });

  it('repeat view does not re-notify (count=0)', async () => {
    mockPrisma.storyView.createMany.mockResolvedValue({ count: 0 });
    const notify = await import('../story.notify');

    await markStoryViewed('s-1', 'viewer-1', false);

    expect(notify.notifyStoryOwnerOfView).not.toHaveBeenCalled();
  });

  it('notifies on first view even with the legacy stealth flag (stealth removed)', async () => {
    mockPrisma.storyView.createMany.mockResolvedValue({ count: 1 });
    const notify = await import('../story.notify');

    // Every view now counts and is visible; the legacy stealth arg is a no-op.
    await markStoryViewed('s-1', 'viewer-1', true);

    expect(notify.notifyStoryOwnerOfView).toHaveBeenCalled();
  });
});

// ─── getStoryViewers ────────────────────────────────────────────────

describe('getStoryViewers', () => {
  it('returns null when story missing', async () => {
    mockPrisma.story.findUnique.mockResolvedValue(null);
    expect(await getStoryViewers('s-x', 'user-1')).toBeNull();
  });

  it('returns null when caller is not the owner', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ userId: 'someone-else' });
    expect(await getStoryViewers('s-1', 'user-1')).toBeNull();
  });

  it('joins user info and includes all viewers', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ userId: 'user-1' });
    mockPrisma.storyView.findMany.mockResolvedValue([
      { viewerId: 'v-1', createdAt: new Date(), liked: true },
      { viewerId: 'v-2', createdAt: new Date(), liked: false },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'v-1', displayName: 'Alice', avatarUrl: null, isVerified: false },
    ]);
    // `liked` now derives from the StoryReaction ❤️ (source of truth); the
    // segmented ring needs the viewers' active slides too.
    mockPrisma.storyReaction.findMany.mockResolvedValue([
      { userId: 'v-1', emoji: '❤️' },
    ]);
    mockPrisma.storySlide.findMany.mockResolvedValue([]);
    mockPrisma.follow.findMany.mockResolvedValue([]);

    const res = await getStoryViewers('s-1', 'user-1');

    expect(mockPrisma.storyView.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { storyId: 's-1' },
    }));
    expect(res).toHaveLength(2);
    expect(res![0]).toMatchObject({ userId: 'v-1', displayName: 'Alice', liked: true });
    // v-2's user record was missing — falls back to "Unknown"
    expect(res![1].displayName).toBe('Unknown');
  });
});

// ─── replyToStory ───────────────────────────────────────────────────

describe('replyToStory', () => {
  it('rejects empty text', async () => {
    await expect(replyToStory('s-1', 'sender', '   ')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns null when story missing', async () => {
    mockPrisma.story.findUnique.mockResolvedValue(null);
    expect(await replyToStory('s-x', 'sender', 'hi')).toBeNull();
  });

  it('rejects replying to own story', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 's-1', userId: 'sender', slides: [] });
    await expect(replyToStory('s-1', 'sender', 'hi')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('creates DM, sends message with story context, increments commentCount', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({
      id: 's-1', userId: 'owner-1',
      slides: [{ id: 'sl-1', type: 'IMAGE', mediaUrl: '/a.jpg', thumbnailUrl: null }],
    });

    const res = await replyToStory('s-1', 'sender-1', 'nice!');

    expect(res).toEqual({ conversationId: 'conv-1', messageId: 'msg-1' });
    expect(mockChatService.sendMessage).toHaveBeenCalledWith('conv-1', 'sender-1', 'nice!', expect.objectContaining({
      metadata: expect.objectContaining({
        storyContext: expect.objectContaining({ storyId: 's-1', ownerId: 'owner-1' }),
      }),
    }));
    expect(mockPrisma.story.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { commentCount: { increment: 1 } },
    });
  });
});

// ─── bumpStoryShare / Download / Repost ─────────────────────────────

describe('bumpStoryShare/Download/Repost', () => {
  it('bumpStoryShare increments shareCount', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 's-1' });
    expect(await bumpStoryShare('s-1')).toBe(true);
    expect(mockPrisma.story.update).toHaveBeenCalledWith({
      where: { id: 's-1' }, data: { shareCount: { increment: 1 } },
    });
  });

  it('bumpStoryDownload increments downloadCount', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 's-1' });
    expect(await bumpStoryDownload('s-1')).toBe(true);
  });

  it('bumpStoryRepost increments repostCount', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 's-1' });
    expect(await bumpStoryRepost('s-1')).toBe(true);
  });

  it('bump funcs return false for missing story', async () => {
    mockPrisma.story.findUnique.mockResolvedValue(null);
    expect(await bumpStoryShare('s-x')).toBe(false);
    expect(await bumpStoryDownload('s-x')).toBe(false);
    expect(await bumpStoryRepost('s-x')).toBe(false);
  });
});

// ─── updateSlideCaption ─────────────────────────────────────────────

describe('updateSlideCaption', () => {
  it('returns not_found when slide missing', async () => {
    mockPrisma.storySlide.findUnique.mockResolvedValue(null);
    expect(await updateSlideCaption('sl-x', 'user-1', 'cap')).toEqual({ updated: false, reason: 'not_found' });
  });

  it('returns not_owner when user does not own the story', async () => {
    mockPrisma.storySlide.findUnique.mockResolvedValue({ story: { userId: 'someone-else' } });
    expect(await updateSlideCaption('sl-1', 'user-1', 'cap')).toEqual({ updated: false, reason: 'not_owner' });
  });

  it('updates caption when owner', async () => {
    mockPrisma.storySlide.findUnique.mockResolvedValue({ story: { userId: 'user-1' } });
    expect(await updateSlideCaption('sl-1', 'user-1', 'new')).toEqual({ updated: true });
  });

  it('null caption clears it', async () => {
    mockPrisma.storySlide.findUnique.mockResolvedValue({ story: { userId: 'user-1' } });

    await updateSlideCaption('sl-1', 'user-1', null);

    expect(mockPrisma.storySlide.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { caption: null },
    }));
  });
});

// ─── deleteStory ────────────────────────────────────────────────────

describe('deleteStory', () => {
  it('returns not_found when story missing', async () => {
    mockPrisma.story.findUnique.mockResolvedValue(null);
    expect(await deleteStory('s-x', 'user-1')).toEqual({ deleted: false, reason: 'not_found' });
  });

  it('returns not_owner when not owner', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ userId: 'other', slides: [] });
    expect(await deleteStory('s-1', 'user-1')).toEqual({ deleted: false, reason: 'not_owner' });
  });

  it('deletes story and queues cloudinary cleanup for each slide', async () => {
    const cdn = await import('../../../shared/cloudinary.service');
    mockPrisma.story.findUnique.mockResolvedValue({
      userId: 'user-1',
      slides: [
        { cloudinaryId: 'pid-1', type: 'IMAGE' },
        { cloudinaryId: 'pid-2', type: 'VIDEO' },
        { cloudinaryId: null, type: 'TEXT' },
      ],
    });

    const res = await deleteStory('s-1', 'user-1');

    expect(res).toEqual({ deleted: true });
    expect(mockPrisma.story.delete).toHaveBeenCalledWith({ where: { id: 's-1' } });
    expect(cdn.deleteFile).toHaveBeenCalledWith('pid-1', 'image');
    expect(cdn.deleteFile).toHaveBeenCalledWith('pid-2', 'video');
  });
});

// ─── cleanupExpiredStories ──────────────────────────────────────────

describe('cleanupExpiredStories', () => {
  it('returns 0 and skips deletion when nothing expired', async () => {
    mockPrisma.story.findMany.mockResolvedValue([]);

    expect(await cleanupExpiredStories()).toBe(0);
    expect(mockPrisma.story.deleteMany).not.toHaveBeenCalled();
  });

  it('hard-deletes expired stories and returns count', async () => {
    mockPrisma.story.findMany.mockResolvedValue([
      { id: 's-1', slides: [{ cloudinaryId: 'pid-1', type: 'IMAGE' }] },
      { id: 's-2', slides: [] },
    ]);
    mockPrisma.story.deleteMany.mockResolvedValue({ count: 2 });

    const res = await cleanupExpiredStories();

    expect(res).toBe(2);
    expect(mockPrisma.story.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-1', 's-2'] } },
    });
  });
});
