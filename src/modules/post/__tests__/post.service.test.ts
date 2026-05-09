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
    commentReaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
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
  getPost,
  toggleLike,
  addComment,
  toggleCommentLike,
  deletePost,
  togglePinPost,
  editCaption,
  toggleReaction,
  toggleBookmark,
  trackView,
  deleteScheduledPost,
  publishScheduledPosts,
} from '../post.service';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';

function basePost(over: Partial<any> = {}) {
  return {
    id: 'post-1',
    channelId: 'chan-1',
    authorId: 'author-1',
    content: 'hi',
    isPublished: true,
    commentsDisabled: false,
    likeCount: 0,
    commentCount: 0,
    media: [],
    likes: [],
    bookmarks: [],
    reactions: [],
    _count: { likes: 0, comments: 0 },
    author: { id: 'author-1', displayName: 'Alice', avatarUrl: null, isVerified: false },
    channel: { id: 'chan-1', name: 'Chan', avatarUrl: null, pinnedPostId: null, isVerified: false, isChannel: true },
    createdAt: new Date('2026-05-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getPost ─────────────────────────────────────────────────────────

describe('getPost', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(null);
    await expect(getPost('p-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns formatted post with derived flags', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost({
      likes: [{ id: 'l1' }],
      bookmarks: [],
      reactions: [{ emoji: '❤️', userId: 'user-1' }, { emoji: '🔥', userId: 'user-2' }],
      _count: { likes: 1, comments: 2 },
    }));

    const res = await getPost('post-1', 'user-1');
    expect(res.id).toBe('post-1');
    expect(res.liked).toBe(true);
    expect(res.bookmarked).toBe(false);
    expect(res.likeCount).toBe(1);
    expect(res.myReaction).toBe('❤️');
    expect(res.reactionCounts).toEqual({ '❤️': 1, '🔥': 1 });
  });
});

// ─── toggleLike ──────────────────────────────────────────────────────

describe('toggleLike', () => {
  it('throws NotFoundError when post missing', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(null);
    await expect(toggleLike('p-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when post is unpublished', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost({ isPublished: false }));
    await expect(toggleLike('post-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when channel is private and user is not a participant', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: false });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(toggleLike('post-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('removes existing like and decrements likeCount', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postLike.findUnique.mockResolvedValue({ id: 'like-1' });

    const res = await toggleLike('post-1', 'user-1');

    expect(res).toEqual({ liked: false });
    expect(mockPrisma.postLike.delete).toHaveBeenCalledWith({ where: { id: 'like-1' } });
    expect(mockPrisma.post.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { likeCount: { decrement: 1 } },
    }));
  });

  it('creates new like, increments, and skips notification when liker is the author', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost({ authorId: 'user-1' }));
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postLike.findUnique.mockResolvedValue(null);

    const res = await toggleLike('post-1', 'user-1');

    expect(res).toEqual({ liked: true });
    expect(mockPrisma.postLike.create).toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('queues notification when liker is not the author', async () => {
    const { enqueuePostNotification } = await import('../../notification/notification-batcher');
    mockPrisma.post.findUnique.mockResolvedValue(basePost({ authorId: 'author-1' }));
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postLike.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Bob', avatarUrl: 'bob.jpg' });

    await toggleLike('post-1', 'user-1');

    expect(enqueuePostNotification).toHaveBeenCalledWith(expect.objectContaining({
      authorId: 'author-1',
      postId: 'post-1',
      type: 'POST_LIKED',
      actorId: 'user-1',
      actorName: 'Bob',
    }));
  });
});

// ─── addComment ──────────────────────────────────────────────────────

describe('addComment', () => {
  it('throws NotFoundError when post missing', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(null);
    await expect(addComment('p-x', 'user-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when comments disabled', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost({ commentsDisabled: true }));
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });

    await expect(addComment('post-1', 'user-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when parentId belongs to a different post', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postComment.findUnique.mockResolvedValue({ id: 'parent-1', postId: 'other-post' });

    await expect(addComment('post-1', 'user-1', 'hi', 'parent-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('creates top-level comment and increments count', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost({ authorId: 'user-1' }));
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postComment.create.mockResolvedValue({
      id: 'c1',
      user: { id: 'user-1', displayName: 'Alice', avatarUrl: null, isVerified: false },
    });

    const res = await addComment('post-1', 'user-1', 'great');

    expect(res.id).toBe('c1');
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

// ─── toggleCommentLike ───────────────────────────────────────────────

describe('toggleCommentLike', () => {
  it('throws NotFoundError when comment missing', async () => {
    mockPrisma.postComment.findUnique.mockResolvedValue(null);
    await expect(toggleCommentLike('c-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('removes existing reaction', async () => {
    mockPrisma.postComment.findUnique.mockResolvedValue({ id: 'c1', likeCount: 1 });
    mockPrisma.commentReaction.findUnique.mockResolvedValue({ id: 'r1' });

    const res = await toggleCommentLike('c1', 'user-1');

    expect(res).toEqual({ liked: false });
    expect(mockPrisma.commentReaction.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });

  it('creates reaction when none exists', async () => {
    mockPrisma.postComment.findUnique.mockResolvedValue({ id: 'c1', likeCount: 0 });
    mockPrisma.commentReaction.findUnique.mockResolvedValue(null);

    const res = await toggleCommentLike('c1', 'user-1');

    expect(res).toEqual({ liked: true });
    expect(mockPrisma.commentReaction.create).toHaveBeenCalledWith({
      data: { commentId: 'c1', userId: 'user-1', emoji: 'like' },
    });
  });
});

// ─── deletePost ──────────────────────────────────────────────────────

describe('deletePost', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(null);
    await expect(deletePost('p-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('author can delete their own post', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ authorId: 'user-1', channelId: 'chan-1' });

    const res = await deletePost('post-1', 'user-1');

    expect(res).toEqual({ deleted: true });
    expect(mockPrisma.post.delete).toHaveBeenCalled();
    expect(mockPrisma.conversationParticipant.findUnique).not.toHaveBeenCalled();
  });

  it('admin can delete others\' posts', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ authorId: 'someone-else', channelId: 'chan-1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });

    await deletePost('post-1', 'admin-1');

    expect(mockPrisma.post.delete).toHaveBeenCalled();
  });

  it('non-author non-admin is forbidden', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ authorId: 'someone-else', channelId: 'chan-1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(deletePost('post-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── togglePinPost ───────────────────────────────────────────────────

describe('togglePinPost', () => {
  it('rejects non-admins', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ channelId: 'chan-1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(togglePinPost('post-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('pins when not currently pinned', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ channelId: 'chan-1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ pinnedPostId: null });

    const res = await togglePinPost('post-1', 'admin-1');

    expect(res).toEqual({ pinned: true });
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { pinnedPostId: 'post-1' },
    }));
  });

  it('unpins when this post is currently pinned', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ channelId: 'chan-1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ pinnedPostId: 'post-1' });

    const res = await togglePinPost('post-1', 'admin-1');

    expect(res).toEqual({ pinned: false });
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { pinnedPostId: null },
    }));
  });
});

// ─── editCaption ─────────────────────────────────────────────────────

describe('editCaption', () => {
  it('author can edit', async () => {
    mockPrisma.post.findUnique
      .mockResolvedValueOnce({ authorId: 'user-1', channelId: 'chan-1' })
      .mockResolvedValueOnce(basePost({ content: 'updated' }));
    mockPrisma.post.update.mockResolvedValue(basePost({ content: 'updated' }));

    const res = await editCaption('post-1', 'user-1', 'updated');

    expect(res.content).toBe('updated');
    expect(mockPrisma.conversationParticipant.findUnique).not.toHaveBeenCalled();
  });

  it('non-author non-admin is forbidden', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({ authorId: 'someone-else', channelId: 'chan-1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(editCaption('post-1', 'user-1', 'x')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── toggleReaction ──────────────────────────────────────────────────

describe('toggleReaction', () => {
  it('removes when same emoji', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postReaction.findUnique.mockResolvedValue({ id: 'r1', emoji: '❤️' });

    const res = await toggleReaction('post-1', 'user-1', '❤️');

    expect(res).toEqual({ reaction: null });
    expect(mockPrisma.postReaction.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });

  it('updates when different emoji', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postReaction.findUnique.mockResolvedValue({ id: 'r1', emoji: '❤️' });

    const res = await toggleReaction('post-1', 'user-1', '🔥');

    expect(res).toEqual({ reaction: '🔥' });
    expect(mockPrisma.postReaction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { emoji: '🔥' },
    }));
  });

  it('creates when no existing reaction', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postReaction.findUnique.mockResolvedValue(null);

    const res = await toggleReaction('post-1', 'user-1', '🎉');

    expect(res).toEqual({ reaction: '🎉' });
    expect(mockPrisma.postReaction.create).toHaveBeenCalledWith({
      data: { postId: 'post-1', userId: 'user-1', emoji: '🎉' },
    });
  });
});

// ─── toggleBookmark ──────────────────────────────────────────────────

describe('toggleBookmark', () => {
  it('removes existing bookmark', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postBookmark.findUnique.mockResolvedValue({ id: 'b1' });

    const res = await toggleBookmark('post-1', 'user-1');

    expect(res).toEqual({ bookmarked: false });
    expect(mockPrisma.postBookmark.delete).toHaveBeenCalled();
  });

  it('creates bookmark when none exists', async () => {
    mockPrisma.post.findUnique.mockResolvedValue(basePost());
    mockPrisma.conversation.findUnique.mockResolvedValue({ isPublic: true });
    mockPrisma.postBookmark.findUnique.mockResolvedValue(null);

    const res = await toggleBookmark('post-1', 'user-1');

    expect(res).toEqual({ bookmarked: true });
    expect(mockPrisma.postBookmark.create).toHaveBeenCalledWith({
      data: { postId: 'post-1', userId: 'user-1' },
    });
  });
});

// ─── trackView ───────────────────────────────────────────────────────

describe('trackView', () => {
  it('increments viewCount', async () => {
    mockPrisma.post.update.mockResolvedValue({});
    await trackView('post-1');
    expect(mockPrisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { viewCount: { increment: 1 } },
    });
  });
});

// ─── deleteScheduledPost ─────────────────────────────────────────────

describe('deleteScheduledPost', () => {
  it('rejects deletion of published posts via this path', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({
      channelId: 'chan-1',
      isPublished: true,
      scheduledAt: null,
    });

    await expect(deleteScheduledPost('post-1', 'admin-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('deletes when admin and unpublished', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({
      channelId: 'chan-1',
      isPublished: false,
      scheduledAt: new Date(),
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });

    const res = await deleteScheduledPost('post-1', 'admin-1');

    expect(res).toEqual({ deleted: true });
    expect(mockPrisma.post.delete).toHaveBeenCalled();
  });

  it('rejects non-admin', async () => {
    mockPrisma.post.findUnique.mockResolvedValue({
      channelId: 'chan-1',
      isPublished: false,
      scheduledAt: new Date(),
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(deleteScheduledPost('post-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── publishScheduledPosts ───────────────────────────────────────────

describe('publishScheduledPosts', () => {
  it('returns early when nothing scheduled', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    await publishScheduledPosts();

    expect(mockPrisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('publishes due posts in bulk', async () => {
    mockPrisma.post.findMany.mockResolvedValue([
      { id: 'p1', channelId: 'c1', authorId: 'a1', content: 'one' },
      { id: 'p2', channelId: 'c1', authorId: 'a1', content: 'two' },
    ]);
    mockPrisma.post.updateMany.mockResolvedValue({ count: 2 });

    await publishScheduledPosts();

    expect(mockPrisma.post.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] } },
      data: { isPublished: true },
    });
  });
});
