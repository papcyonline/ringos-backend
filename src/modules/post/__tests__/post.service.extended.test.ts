import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const tx = vi.fn(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  const mockPrisma: any = {
    post: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    postLike: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    postComment: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    postReaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    postBookmark: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    postMedia: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    conversationParticipant: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: tx,
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../notification/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(null),
  sendPostPush: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../notification/notification-batcher', () => ({
  enqueuePostNotification: vi.fn(),
}));

import {
  createPost,
  getFeed,
  getChannelPosts,
  discoverPosts,
  searchByHashtag,
  getTrendingHashtags,
  getComments,
  bulkDeletePosts,
  getChannelAnalytics,
  getBookmarkedPosts,
  getScheduledPosts,
  getFeedWithAlgorithm,
} from '../post.service';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';

const basePost = (over: Partial<any> = {}) => ({
  id: 'p-1',
  channelId: 'chan-1',
  authorId: 'author-1',
  content: 'hi',
  isPublished: true,
  commentsDisabled: false,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  viewCount: 0,
  media: [],
  likes: [],
  bookmarks: [],
  reactions: [],
  _count: { likes: 0, comments: 0 },
  author: { id: 'author-1', displayName: 'Alice', avatarUrl: null, isVerified: false },
  channel: { id: 'chan-1', name: 'Chan', avatarUrl: null, pinnedPostId: null, isVerified: false, isChannel: true },
  createdAt: new Date('2026-05-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── createPost ──────────────────────────────────────────────────────

describe('createPost', () => {
  it('throws NotFoundError when channel missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    await expect(createPost('c-x', 'a-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when conversation is not a channel', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: false, status: 'ACTIVE' });
    await expect(createPost('c-1', 'a-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError when channel is no longer ACTIVE', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: true, status: 'ENDED' });
    await expect(createPost('c-1', 'a-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects non-admin', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: true, status: 'ACTIVE' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(createPost('c-1', 'a-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('creates published post immediately when no scheduledAt', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: true, status: 'ACTIVE' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.create.mockResolvedValue({ id: 'p-1' });
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A' });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    await createPost('chan-1', 'admin-1', 'hello');

    expect(mockPrisma.post.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: 'hello' }),
    }));
    // No scheduling means no isPublished:false override
    const callData = (mockPrisma.post.create.mock.calls[0][0] as any).data;
    expect(callData.scheduledAt).toBeUndefined();
  });

  it('schedules future post with isPublished=false', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: true, status: 'ACTIVE' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.create.mockResolvedValue({ id: 'p-1' });
    mockPrisma.post.findUnique.mockResolvedValue(basePost());

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await createPost('chan-1', 'admin-1', 'planned', undefined, undefined, undefined, undefined, { scheduledAt: future });

    expect(mockPrisma.post.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isPublished: false,
        scheduledAt: expect.any(Date),
      }),
    }));
  });

  it('creates album media when media[] provided', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: true, status: 'ACTIVE' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.create.mockResolvedValue({ id: 'p-1' });
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A' });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    const media = [
      { url: '/a.jpg', type: 'IMAGE', cloudinaryId: 'cid-a', position: 0 },
      { url: '/b.jpg', type: 'IMAGE', cloudinaryId: 'cid-b', position: 1 },
    ];

    await createPost('chan-1', 'admin-1', 'album', undefined, undefined, undefined, media);

    expect(mockPrisma.postMedia.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ url: '/a.jpg', position: 0 }),
        expect.objectContaining({ url: '/b.jpg', position: 1 }),
      ]),
    }));
  });

  it('falls back to legacy single-media when media[] empty but mediaUrl set', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ isChannel: true, status: 'ACTIVE' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.create.mockResolvedValue({ id: 'p-1' });
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'A' });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    await createPost('chan-1', 'admin-1', 'one', '/img.jpg', 'image');

    expect(mockPrisma.postMedia.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        url: '/img.jpg',
        type: 'IMAGE',
        position: 0,
      }),
    }));
  });
});

// ─── getFeed ─────────────────────────────────────────────────────────

describe('getFeed', () => {
  it('returns empty feed when user subscribes to no channels', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    const res = await getFeed('user-1');

    expect(res).toEqual({ posts: [], hasMore: false });
    expect(mockPrisma.post.findMany).not.toHaveBeenCalled();
  });

  it('queries posts from subscribed channels only', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { conversationId: 'c-1' },
      { conversationId: 'c-2' },
    ]);
    mockPrisma.post.findMany.mockResolvedValue([]);

    await getFeed('user-1');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        channelId: { in: ['c-1', 'c-2'] },
        isPublished: true,
      }),
    }));
  });
});

// ─── getChannelPosts ─────────────────────────────────────────────────

describe('getChannelPosts', () => {
  it('paginates with cursor when provided', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ createdAt: new Date('2026-05-01') });
    mockPrisma.post.findMany.mockResolvedValue([]);

    await getChannelPosts('chan-1', 'user-1', 'cursor-post-id');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: { lt: expect.any(Date) },
      }),
    }));
  });

  it('hasMore=true when query returns limit+1 posts', async () => {
    const posts = Array.from({ length: 21 }, (_, i) => basePost({ id: `p-${i}` }));
    mockPrisma.post.findMany.mockResolvedValue(posts);

    const res = await getChannelPosts('chan-1', 'user-1');

    expect(res.posts).toHaveLength(20);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe('p-19');
  });
});

// ─── discoverPosts ───────────────────────────────────────────────────

describe('discoverPosts', () => {
  it('algorithm=recent uses simple paginated query', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    await discoverPosts('user-1', undefined, 20, 'recent');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { createdAt: 'desc' },
    }));
  });

  it('algorithm=trending ranks by engagement / age decay', async () => {
    const now = Date.now();
    mockPrisma.post.findMany.mockResolvedValue([
      basePost({ id: 'old-popular', createdAt: new Date(now - 6 * 24 * 3600 * 1000), _count: { likes: 100, comments: 20 } }),
      basePost({ id: 'new-popular', createdAt: new Date(now - 2 * 3600 * 1000), _count: { likes: 50, comments: 5 } }),
    ]);

    const res = await discoverPosts('user-1', undefined, 20, 'trending');

    // newer high-engagement post should win the time-decay tiebreaker
    expect(res.posts[0].id).toBe('new-popular');
  });

  it('algorithm=foryou returns paginated list and cursor when more available', async () => {
    const posts = Array.from({ length: 25 }, (_, i) => basePost({ id: `p-${i}` }));
    mockPrisma.post.findMany.mockResolvedValue(posts);

    const res = await discoverPosts('user-1', undefined, 20, 'foryou');

    expect(res.posts).toHaveLength(20);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe('1');
  });
});

// ─── getFeedWithAlgorithm ────────────────────────────────────────────

describe('getFeedWithAlgorithm', () => {
  it('returns empty when no subscriptions', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    const res = await getFeedWithAlgorithm('user-1', undefined, 20, 'trending');

    expect(res).toEqual({ posts: [], hasMore: false });
  });

  it('algorithm=recent delegates to paginated query', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ conversationId: 'c-1' }]);
    mockPrisma.post.findMany.mockResolvedValue([]);

    await getFeedWithAlgorithm('user-1', undefined, 20, 'recent');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        channelId: { in: ['c-1'] },
        isPublished: true,
      }),
    }));
  });

  it('algorithm=trending applies time-window filter', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ conversationId: 'c-1' }]);
    mockPrisma.post.findMany.mockResolvedValue([]);

    await getFeedWithAlgorithm('user-1', undefined, 20, 'trending');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: { gte: expect.any(Date) },
      }),
    }));
  });
});

// ─── searchByHashtag ─────────────────────────────────────────────────

describe('searchByHashtag', () => {
  it('prepends # when missing', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    await searchByHashtag('react', 'user-1');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        content: { contains: '#react', mode: 'insensitive' },
      }),
    }));
  });

  it('keeps existing #', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    await searchByHashtag('#dart', 'user-1');

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        content: { contains: '#dart', mode: 'insensitive' },
      }),
    }));
  });
});

// ─── getTrendingHashtags ─────────────────────────────────────────────

describe('getTrendingHashtags', () => {
  it('returns counts sorted descending and lowercased', async () => {
    mockPrisma.post.findMany.mockResolvedValue([
      { content: 'hello #React #flutter' },
      { content: '#flutter rocks' },
      { content: '#flutter > #react' },
    ]);

    const res = await getTrendingHashtags(5);

    expect(res[0]).toEqual({ tag: '#flutter', count: 3 });
    expect(res[1]).toEqual({ tag: '#react', count: 2 });
  });

  it('returns [] for posts without hashtags', async () => {
    mockPrisma.post.findMany.mockResolvedValue([{ content: 'no tags here' }]);

    expect(await getTrendingHashtags()).toEqual([]);
  });
});

// ─── getComments ─────────────────────────────────────────────────────

describe('getComments', () => {
  it('formats comments with derived liked/replyCount', async () => {
    mockPrisma.postComment.findMany.mockResolvedValue([
      {
        id: 'c1',
        reactions: [{ emoji: 'like' }],
        _count: { replies: 2, reactions: 5 },
        replies: [
          {
            id: 'r1',
            reactions: [],
            _count: { replies: 0, reactions: 0 },
          },
        ],
      },
    ]);

    const res = await getComments('p-1', 'user-1');

    expect(res.comments[0]).toMatchObject({
      id: 'c1',
      liked: true,
      replyCount: 2,
      reactionCount: 5,
    });
    expect(res.comments[0].replies[0]).toMatchObject({
      id: 'r1',
      liked: false,
      replyCount: 0,
    });
  });

  it('hasMore=true when over limit, slices off the extra', async () => {
    const comments = Array.from({ length: 31 }, (_, i) => ({
      id: `c-${i}`,
      reactions: [],
      _count: { replies: 0, reactions: 0 },
      replies: [],
    }));
    mockPrisma.postComment.findMany.mockResolvedValue(comments);

    const res = await getComments('p-1', 'user-1');

    expect(res.comments).toHaveLength(30);
    expect(res.hasMore).toBe(true);
  });

  it('uses cursor when provided', async () => {
    mockPrisma.postComment.findUnique.mockResolvedValue({ createdAt: new Date('2026-05-01') });
    mockPrisma.postComment.findMany.mockResolvedValue([]);

    await getComments('p-1', 'user-1', 'cursor-c1');

    expect(mockPrisma.postComment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: { gt: expect.any(Date) },
      }),
    }));
  });
});

// ─── bulkDeletePosts ─────────────────────────────────────────────────

describe('bulkDeletePosts', () => {
  it('returns {deleted: 0} for empty list', async () => {
    expect(await bulkDeletePosts([], 'admin-1')).toEqual({ deleted: 0 });
  });

  it('throws NotFoundError when none found', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);
    await expect(bulkDeletePosts(['p-x'], 'admin-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when caller is not admin in any of the channels', async () => {
    mockPrisma.post.findMany
      .mockResolvedValueOnce([{ id: 'p-1', channelId: 'c-1' }, { id: 'p-2', channelId: 'c-2' }]);
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ role: 'MEMBER' });

    await expect(bulkDeletePosts(['p-1', 'p-2'], 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admin can bulk delete', async () => {
    mockPrisma.post.findMany.mockResolvedValueOnce([{ id: 'p-1', channelId: 'c-1' }]);
    mockPrisma.postMedia.findMany.mockResolvedValue([]);
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.deleteMany.mockResolvedValue({ count: 1 });

    const res = await bulkDeletePosts(['p-1'], 'admin-1');

    expect(res).toEqual({ deleted: 1 });
    expect(mockPrisma.post.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['p-1'] } } });
  });
});

// ─── getChannelAnalytics ─────────────────────────────────────────────

describe('getChannelAnalytics', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(getChannelAnalytics('c-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('aggregates totals and weekly buckets', async () => {
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.findMany.mockResolvedValue([
      { id: 'p1', likeCount: 5, commentCount: 2, shareCount: 1, viewCount: 100, createdAt: new Date(now - 1000) },
      { id: 'p2', likeCount: 3, commentCount: 1, shareCount: 0, viewCount: 50, createdAt: new Date(now - week - 1000) },
    ]);
    mockPrisma.conversationParticipant.count.mockResolvedValue(42);
    mockPrisma.conversation.findUnique.mockResolvedValue({ createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000) });

    const res = await getChannelAnalytics('c-1', 'admin-1');

    expect(res.totalPosts).toBe(2);
    expect(res.totalLikes).toBe(8);
    expect(res.totalComments).toBe(3);
    expect(res.followers).toBe(42);
    expect(res.weeklyPosts[0]).toBe(1);
    expect(res.weeklyPosts[1]).toBe(1);
    expect(res.topPosts).toHaveLength(2);
    expect(res.channelAge).toBe(30);
  });

  it('avgEngagement is "0" when no posts', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.findMany.mockResolvedValue([]);
    mockPrisma.conversationParticipant.count.mockResolvedValue(0);
    mockPrisma.conversation.findUnique.mockResolvedValue({ createdAt: new Date() });

    const res = await getChannelAnalytics('c-1', 'admin-1');

    expect(res.avgEngagement).toBe('0');
  });
});

// ─── getBookmarkedPosts ──────────────────────────────────────────────

describe('getBookmarkedPosts', () => {
  it('filters out unpublished posts and marks bookmarked=true', async () => {
    mockPrisma.postBookmark.findMany.mockResolvedValue([
      { id: 'b1', post: { ...basePost(), isPublished: true } },
      { id: 'b2', post: { ...basePost(), isPublished: false, id: 'p-hidden' } },
    ]);

    const res = await getBookmarkedPosts('user-1');

    expect(res.posts).toHaveLength(1);
    expect((res.posts[0] as any).bookmarked).toBe(true);
  });

  it('paginates with cursor', async () => {
    mockPrisma.postBookmark.findUnique.mockResolvedValue({ createdAt: new Date('2026-05-01') });
    mockPrisma.postBookmark.findMany.mockResolvedValue([]);

    await getBookmarkedPosts('user-1', 'b-cursor');

    expect(mockPrisma.postBookmark.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        createdAt: { lt: expect.any(Date) },
      }),
    }));
  });
});

// ─── getScheduledPosts ───────────────────────────────────────────────

describe('getScheduledPosts', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(getScheduledPosts('c-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns formatted scheduled posts for admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.post.findMany.mockResolvedValue([basePost({ id: 's-1', isPublished: false })]);

    const res = await getScheduledPosts('c-1', 'admin-1');

    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('s-1');
  });
});
