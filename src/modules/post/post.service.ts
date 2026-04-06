import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';

const postInclude = {
  author: {
    select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
  },
  channel: {
    select: { id: true, name: true, avatarUrl: true, isVerified: true, isChannel: true },
  },
  _count: { select: { likes: true, comments: true } },
};

/**
 * Create a post in a channel. Only channel admins can post.
 */
export async function createPost(
  channelId: string,
  authorId: string,
  content: string,
  mediaUrl?: string,
  mediaType?: string,
  thumbnailUrl?: string,
) {
  const channel = await prisma.conversation.findUnique({
    where: { id: channelId },
    select: { isChannel: true, status: true },
  });
  if (!channel || !channel.isChannel) throw new NotFoundError('Channel not found');
  if (channel.status !== 'ACTIVE') throw new ForbiddenError('Channel is no longer active');

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId: authorId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only channel admins can create posts');
  }

  const post = await prisma.post.create({
    data: {
      channelId,
      authorId,
      content,
      mediaUrl: mediaUrl ?? null,
      mediaType: mediaType ?? null,
      thumbnailUrl: thumbnailUrl ?? null,
    },
    include: postInclude,
  });

  logger.info({ postId: post.id, channelId, authorId }, 'Post created');
  return formatPost(post, authorId);
}

/**
 * Get the updates feed for a user — posts from channels they subscribe to.
 */
export async function getFeed(userId: string, cursor?: string, limit = 20) {
  // Get channel IDs the user subscribes to
  const subscriptions = await prisma.conversationParticipant.findMany({
    where: {
      userId,
      leftAt: null,
      conversation: { isChannel: true, status: 'ACTIVE' },
    },
    select: { conversationId: true },
  });
  const channelIds = subscriptions.map((s) => s.conversationId);

  if (channelIds.length === 0) return { posts: [], hasMore: false };

  const where: any = { channelId: { in: channelIds } };
  if (cursor) {
    const cursorPost = await prisma.post.findUnique({
      where: { id: cursor },
      select: { createdAt: true },
    });
    if (cursorPost) where.createdAt = { lt: cursorPost.createdAt };
  }

  const posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      ...postInclude,
      likes: { where: { userId }, select: { id: true }, take: 1 },
    },
  });

  const hasMore = posts.length > limit;
  const sliced = hasMore ? posts.slice(0, limit) : posts;

  return {
    posts: sliced.map((p) => formatPost(p, userId)),
    hasMore,
    nextCursor: sliced.length > 0 ? sliced[sliced.length - 1].id : undefined,
  };
}

/**
 * Get posts for a specific channel.
 */
export async function getChannelPosts(channelId: string, userId: string, cursor?: string, limit = 20) {
  const where: any = { channelId };
  if (cursor) {
    const cursorPost = await prisma.post.findUnique({
      where: { id: cursor },
      select: { createdAt: true },
    });
    if (cursorPost) where.createdAt = { lt: cursorPost.createdAt };
  }

  const posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      ...postInclude,
      likes: { where: { userId }, select: { id: true }, take: 1 },
    },
  });

  const hasMore = posts.length > limit;
  const sliced = hasMore ? posts.slice(0, limit) : posts;

  return {
    posts: sliced.map((p) => formatPost(p, userId)),
    hasMore,
    nextCursor: sliced.length > 0 ? sliced[sliced.length - 1].id : undefined,
  };
}

/**
 * Discover posts — public channel posts for non-subscribers.
 */
export async function discoverPosts(userId: string, cursor?: string, limit = 20) {
  const where: any = {
    channel: { isChannel: true, isPublic: true, status: 'ACTIVE' },
  };
  if (cursor) {
    const cursorPost = await prisma.post.findUnique({
      where: { id: cursor },
      select: { createdAt: true },
    });
    if (cursorPost) where.createdAt = { lt: cursorPost.createdAt };
  }

  const posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      ...postInclude,
      likes: { where: { userId }, select: { id: true }, take: 1 },
    },
  });

  const hasMore = posts.length > limit;
  const sliced = hasMore ? posts.slice(0, limit) : posts;

  return {
    posts: sliced.map((p) => formatPost(p, userId)),
    hasMore,
    nextCursor: sliced.length > 0 ? sliced[sliced.length - 1].id : undefined,
  };
}

/**
 * Like or unlike a post.
 */
export async function toggleLike(postId: string, userId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new NotFoundError('Post not found');

  const existing = await prisma.postLike.findUnique({
    where: { postId_userId: { postId, userId } },
  });

  if (existing) {
    await prisma.$transaction([
      prisma.postLike.delete({ where: { id: existing.id } }),
      prisma.post.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } } }),
    ]);
    return { liked: false };
  }

  await prisma.$transaction([
    prisma.postLike.create({ data: { postId, userId } }),
    prisma.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } }),
  ]);
  return { liked: true };
}

/**
 * Add a comment to a post.
 */
export async function addComment(postId: string, userId: string, content: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new NotFoundError('Post not found');

  const [comment] = await prisma.$transaction([
    prisma.postComment.create({
      data: { postId, userId, content },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true, isVerified: true } },
      },
    }),
    prisma.post.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } }),
  ]);

  return comment;
}

/**
 * Get comments for a post.
 */
export async function getComments(postId: string, cursor?: string, limit = 30) {
  const where: any = { postId };
  if (cursor) {
    const cursorComment = await prisma.postComment.findUnique({
      where: { id: cursor },
      select: { createdAt: true },
    });
    if (cursorComment) where.createdAt = { gt: cursorComment.createdAt };
  }

  const comments = await prisma.postComment.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: limit + 1,
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true, isVerified: true } },
    },
  });

  const hasMore = comments.length > limit;
  return {
    comments: hasMore ? comments.slice(0, limit) : comments,
    hasMore,
  };
}

/**
 * Delete a post. Only the author or channel admin can delete.
 */
export async function deletePost(postId: string, userId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { authorId: true, channelId: true },
  });
  if (!post) throw new NotFoundError('Post not found');

  if (post.authorId !== userId) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: post.channelId, userId } },
    });
    if (!participant || participant.role !== 'ADMIN') {
      throw new ForbiddenError('Only the author or channel admins can delete posts');
    }
  }

  await prisma.post.delete({ where: { id: postId } });
  logger.info({ postId, userId }, 'Post deleted');
  return { deleted: true };
}

// ── Helpers ──

function formatPost(post: any, currentUserId: string) {
  const liked = post.likes?.length > 0;
  return {
    id: post.id,
    channelId: post.channelId,
    content: post.content,
    mediaUrl: post.mediaUrl,
    mediaType: post.mediaType,
    thumbnailUrl: post.thumbnailUrl,
    likeCount: post._count?.likes ?? post.likeCount ?? 0,
    commentCount: post._count?.comments ?? post.commentCount ?? 0,
    shareCount: post.shareCount ?? 0,
    liked,
    author: post.author,
    channel: post.channel,
    createdAt: post.createdAt,
  };
}
