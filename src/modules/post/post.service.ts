import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { createNotification } from '../notification/notification.service';

async function verifyChannelAdmin(channelId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only channel admins can perform this action');
  }
  return participant;
}

/**
 * Verify a user can access a post (channel is public or user is a subscriber).
 */
async function verifyPostAccess(post: { channelId: string; isPublished: boolean }, userId: string) {
  if (!post.isPublished) throw new ForbiddenError('Cannot interact with an unpublished post');
  const channel = await prisma.conversation.findUnique({
    where: { id: post.channelId },
    select: { isPublic: true },
  });
  if (channel?.isPublic) return;
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: post.channelId, userId } },
  });
  if (!participant || participant.leftAt !== null) {
    throw new ForbiddenError('You do not have access to this post');
  }
}

/**
 * Shared paginated post query. Handles cursor, limit, includes, and formatting.
 */
async function queryPaginatedPosts(where: any, userId: string, cursor?: string, limit = 20) {
  if (cursor) {
    const cursorPost = await prisma.post.findUnique({ where: { id: cursor }, select: { createdAt: true } });
    if (cursorPost) where.createdAt = { lt: cursorPost.createdAt };
  }

  const posts = await prisma.post.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      ...postInclude,
      likes: { where: { userId }, select: { id: true }, take: 1 },
      bookmarks: { where: { userId }, select: { id: true }, take: 1 },
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

const postInclude = {
  author: {
    select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
  },
  channel: {
    select: { id: true, name: true, avatarUrl: true, isVerified: true, isChannel: true },
  },
  media: { orderBy: { position: 'asc' as const } },
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
  media?: Array<{ url: string; type: string; thumbnailUrl?: string; cloudinaryId: string; position: number }>,
  options?: {
    locationName?: string;
    taggedUserIds?: string[];
    musicTitle?: string;
    musicArtist?: string;
    commentsDisabled?: boolean;
    hideLikeCount?: boolean;
    scheduledAt?: string;
  },
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

  // Determine top-level mediaUrl/mediaType from first media item for backward compat
  const firstMedia = media?.[0];
  const effectiveMediaUrl = mediaUrl ?? firstMedia?.url ?? null;
  const effectiveMediaType = mediaType ?? (firstMedia ? (firstMedia.type === 'VIDEO' ? 'video' : 'image') : null);
  const effectiveThumbnailUrl = thumbnailUrl ?? firstMedia?.thumbnailUrl ?? null;

  const scheduledAt = options?.scheduledAt ? new Date(options.scheduledAt) : null;
  const isScheduled = scheduledAt && scheduledAt > new Date();

  // Create post and media in a transaction
  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        channelId,
        authorId,
        content,
        mediaUrl: effectiveMediaUrl,
        mediaType: effectiveMediaType,
        thumbnailUrl: effectiveThumbnailUrl,
        locationName: options?.locationName ?? null,
        taggedUserIds: options?.taggedUserIds ?? [],
        musicTitle: options?.musicTitle ?? null,
        musicArtist: options?.musicArtist ?? null,
        commentsDisabled: options?.commentsDisabled ?? false,
        hideLikeCount: options?.hideLikeCount ?? false,
        ...(isScheduled ? { scheduledAt, isPublished: false } : {}),
      },
      include: postInclude,
    });

    if (media && media.length > 0) {
      await tx.postMedia.createMany({
        data: media.map((m) => ({
          postId: created.id,
          type: m.type,
          url: m.url,
          cloudinaryId: m.cloudinaryId,
          thumbnailUrl: m.thumbnailUrl ?? null,
          position: m.position,
        })),
      });
    } else if (effectiveMediaUrl) {
      await tx.postMedia.create({
        data: {
          postId: created.id,
          type: effectiveMediaType === 'video' ? 'VIDEO' : 'IMAGE',
          url: effectiveMediaUrl,
          thumbnailUrl: effectiveThumbnailUrl,
          position: 0,
        },
      });
    }

    return created;
  });

  // Re-fetch with media included
  const fullPost = await prisma.post.findUnique({
    where: { id: post.id },
    include: {
      ...postInclude,
      likes: { where: { userId: authorId }, select: { id: true }, take: 1 },
      bookmarks: { where: { userId: authorId }, select: { id: true }, take: 1 },
    },
  });

  logger.info({ postId: post.id, channelId, authorId, mediaCount: media?.length ?? (effectiveMediaUrl ? 1 : 0), scheduled: !!isScheduled }, 'Post created');

  // Only notify for immediately published posts (not scheduled)
  if (!isScheduled) {
    notifyChannelFollowers(channelId, authorId, post.id, content).catch((err) =>
      logger.error({ err, channelId }, 'Failed to notify followers about new post'));

    // Notify tagged/mentioned users
    const taggedIds = options?.taggedUserIds ?? [];
    if (taggedIds.length > 0) {
      notifyTaggedUsers(taggedIds, authorId, post.id, channelId).catch((err) =>
        logger.error({ err, postId: post.id }, 'Failed to notify mentioned users'));
    }
  }

  return formatPost(fullPost ?? post, authorId);
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

  return queryPaginatedPosts({ channelId: { in: channelIds }, isPublished: true }, userId, cursor, limit);
}

/**
 * Get posts for a specific channel.
 */
export async function getChannelPosts(channelId: string, userId: string, cursor?: string, limit = 20) {
  return queryPaginatedPosts({ channelId, isPublished: true }, userId, cursor, limit);
}

/**
 * Discover posts — public channel posts for non-subscribers.
 */
export async function discoverPosts(userId: string, cursor?: string, limit = 20) {
  return queryPaginatedPosts({
    isPublished: true,
    channel: { isChannel: true, isPublic: true, status: 'ACTIVE' },
  }, userId, cursor, limit);
}

/**
 * Search posts by hashtag.
 */
export async function searchByHashtag(hashtag: string, userId: string, cursor?: string, limit = 20) {
  const tag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  return queryPaginatedPosts({
    isPublished: true,
    content: { contains: tag, mode: 'insensitive' },
    channel: { isChannel: true, status: 'ACTIVE' },
  }, userId, cursor, limit);
}

/**
 * Like or unlike a post.
 */
export async function toggleLike(postId: string, userId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new NotFoundError('Post not found');
  await verifyPostAccess(post, userId);

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

  // Notify post author (don't notify self)
  if (post.authorId !== userId) {
    const liker = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, avatarUrl: true, isVerified: true },
    });
    if (liker) {
      createNotification({
        userId: post.authorId,
        type: 'POST_LIKED',
        title: liker.displayName ?? 'Someone',
        body: 'Liked your post',
        imageUrl: liker.avatarUrl ?? undefined,
        data: { postId, channelId: post.channelId, userId, isVerified: liker.isVerified },
      }).catch((err) => logger.error({ err, postId }, 'Failed to create post like notification'));
    }
  }

  return { liked: true };
}

/**
 * Add a comment to a post.
 */
export async function addComment(postId: string, userId: string, content: string, parentId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new NotFoundError('Post not found');
  await verifyPostAccess(post, userId);
  if (post.commentsDisabled) throw new ForbiddenError('Comments are disabled on this post');

  if (parentId) {
    const parent = await prisma.postComment.findUnique({ where: { id: parentId } });
    if (!parent || parent.postId !== postId) throw new NotFoundError('Parent comment not found');
  }

  const [comment] = await prisma.$transaction([
    prisma.postComment.create({
      data: { postId, userId, content, parentId: parentId ?? null },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true, isVerified: true } },
      },
    }),
    prisma.post.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } }),
  ]);

  // Notify post author (don't notify self)
  if (post.authorId !== userId) {
    const commenter = comment.user;
    createNotification({
      userId: post.authorId,
      type: 'POST_COMMENTED',
      title: commenter.displayName ?? 'Someone',
      body: content.length > 100 ? content.substring(0, 97) + '...' : content,
      imageUrl: commenter.avatarUrl ?? undefined,
      data: { postId, channelId: post.channelId, userId, isVerified: commenter.isVerified },
    }).catch((err) => logger.error({ err, postId }, 'Failed to create post comment notification'));
  }

  return comment;
}

/**
 * Get comments for a post.
 */
export async function getComments(postId: string, userId: string, cursor?: string, limit = 30) {
  const where: any = { postId, parentId: null }; // Only top-level comments
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
      reactions: { where: { userId }, select: { emoji: true }, take: 1 },
      _count: { select: { replies: true, reactions: true } },
      replies: {
        take: 3,
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { id: true, displayName: true, avatarUrl: true, isVerified: true } },
          reactions: { where: { userId }, select: { emoji: true }, take: 1 },
          _count: { select: { replies: true, reactions: true } },
        },
      },
    },
  });

  const hasMore = comments.length > limit;
  const sliced = hasMore ? comments.slice(0, limit) : comments;
  return {
    comments: sliced.map((c: any) => ({
      ...c,
      liked: c.reactions?.length > 0,
      replyCount: c._count?.replies ?? 0,
      reactionCount: c._count?.reactions ?? 0,
      replies: (c.replies ?? []).map((r: any) => ({
        ...r,
        liked: r.reactions?.length > 0,
        replyCount: r._count?.replies ?? 0,
        reactionCount: r._count?.reactions ?? 0,
      })),
    })),
    hasMore,
  };
}

/**
 * Like/unlike a comment.
 */
export async function toggleCommentLike(commentId: string, userId: string) {
  const comment = await prisma.postComment.findUnique({ where: { id: commentId } });
  if (!comment) throw new NotFoundError('Comment not found');

  const existing = await prisma.commentReaction.findUnique({
    where: { commentId_userId: { commentId, userId } },
  });

  if (existing) {
    await prisma.$transaction([
      prisma.commentReaction.delete({ where: { id: existing.id } }),
      prisma.postComment.update({ where: { id: commentId }, data: { likeCount: { decrement: 1 } } }),
    ]);
    return { liked: false };
  }

  await prisma.$transaction([
    prisma.commentReaction.create({ data: { commentId, userId, emoji: 'like' } }),
    prisma.postComment.update({ where: { id: commentId }, data: { likeCount: { increment: 1 } } }),
  ]);
  return { liked: true };
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

/**
 * Pin/unpin a post on the channel.
 */
export async function togglePinPost(postId: string, userId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { channelId: true } });
  if (!post) throw new NotFoundError('Post not found');

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: post.channelId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') throw new ForbiddenError('Only admins can pin posts');

  const channel = await prisma.conversation.findUnique({ where: { id: post.channelId }, select: { pinnedPostId: true } });
  const isPinned = channel?.pinnedPostId === postId;

  await prisma.conversation.update({
    where: { id: post.channelId },
    data: { pinnedPostId: isPinned ? null : postId },
  });

  return { pinned: !isPinned };
}

/**
 * Edit post caption.
 */
export async function editCaption(postId: string, userId: string, content: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, channelId: true } });
  if (!post) throw new NotFoundError('Post not found');

  if (post.authorId !== userId) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: post.channelId, userId } },
    });
    if (!participant || participant.role !== 'ADMIN') throw new ForbiddenError('Only the author or admins can edit');
  }

  const updated = await prisma.post.update({
    where: { id: postId },
    data: { content },
    include: postInclude,
  });
  return formatPost(updated, userId);
}

/**
 * Track a post view.
 */
export async function trackView(postId: string) {
  await prisma.post.update({
    where: { id: postId },
    data: { viewCount: { increment: 1 } },
  });
}

/**
 * Get channel analytics.
 */
export async function getChannelAnalytics(channelId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') throw new ForbiddenError('Only admins can view analytics');

  const [posts, followers, channel] = await Promise.all([
    prisma.post.findMany({
      where: { channelId, isPublished: true },
      select: { id: true, likeCount: true, commentCount: true, shareCount: true, viewCount: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.conversationParticipant.count({
      where: { conversationId: channelId, leftAt: null },
    }),
    prisma.conversation.findUnique({
      where: { id: channelId },
      select: { createdAt: true },
    }),
  ]);

  const totalLikes = posts.reduce((sum, p) => sum + p.likeCount, 0);
  const totalComments = posts.reduce((sum, p) => sum + p.commentCount, 0);
  const totalShares = posts.reduce((sum, p) => sum + p.shareCount, 0);
  const totalViews = posts.reduce((sum, p) => sum + p.viewCount, 0);
  const avgEngagement = posts.length > 0
    ? ((totalLikes + totalComments + totalShares) / posts.length).toFixed(1)
    : '0';

  // Posts per week (last 4 weeks)
  const now = new Date();
  const weeklyPosts = [0, 0, 0, 0];
  for (const p of posts) {
    const weeksAgo = Math.floor((now.getTime() - p.createdAt.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (weeksAgo < 4) weeklyPosts[weeksAgo]++;
  }

  // Top posts
  const topPosts = [...posts]
    .sort((a, b) => (b.likeCount + b.commentCount) - (a.likeCount + a.commentCount))
    .slice(0, 5)
    .map(p => ({ id: p.id, likes: p.likeCount, comments: p.commentCount, views: p.viewCount }));

  return {
    followers,
    totalPosts: posts.length,
    totalLikes,
    totalComments,
    totalShares,
    totalViews,
    avgEngagement,
    weeklyPosts,
    topPosts,
    channelAge: channel?.createdAt ? Math.floor((now.getTime() - channel.createdAt.getTime()) / (24 * 60 * 60 * 1000)) : 0,
  };
}

/**
 * Notify all channel followers about a new post.
 */
async function notifyChannelFollowers(channelId: string, authorId: string, postId: string, content: string) {
  const [channel, author, followers] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: channelId }, select: { name: true, avatarUrl: true } }),
    prisma.user.findUnique({ where: { id: authorId }, select: { displayName: true } }),
    prisma.conversationParticipant.findMany({
      where: { conversationId: channelId, leftAt: null, userId: { not: authorId } },
      select: { userId: true, isMuted: true },
    }),
  ]);

  if (!channel || followers.length === 0) return;

  const title = channel.name ?? 'Channel';
  const body = content.length > 100 ? content.substring(0, 97) + '...' : (content || 'New post');

  for (const follower of followers) {
    if (follower.isMuted) continue;
    createNotification({
      userId: follower.userId,
      type: 'NEW_POST',
      title,
      body,
      imageUrl: channel.avatarUrl ?? undefined,
      data: { postId, channelId, authorId },
    }).catch(() => {});
  }
}

// ── Helpers ──

function formatPost(post: any, currentUserId: string) {
  const liked = post.likes?.length > 0;
  const media = (post.media ?? []).map((m: any) => ({
    id: m.id,
    type: m.type,
    url: m.url,
    thumbnailUrl: m.thumbnailUrl,
    position: m.position,
  }));
  return {
    id: post.id,
    channelId: post.channelId,
    content: post.content,
    mediaUrl: post.mediaUrl,
    mediaType: post.mediaType,
    thumbnailUrl: post.thumbnailUrl,
    media,
    locationName: post.locationName,
    taggedUserIds: post.taggedUserIds,
    musicTitle: post.musicTitle,
    musicArtist: post.musicArtist,
    commentsDisabled: post.commentsDisabled,
    hideLikeCount: post.hideLikeCount,
    likeCount: post._count?.likes ?? post.likeCount ?? 0,
    commentCount: post._count?.comments ?? post.commentCount ?? 0,
    shareCount: post.shareCount ?? 0,
    liked,
    bookmarked: post.bookmarks?.length > 0,
    author: post.author,
    channel: post.channel,
    createdAt: post.createdAt,
  };
}

/**
 * Toggle bookmark on a post.
 */
export async function toggleBookmark(postId: string, userId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new NotFoundError('Post not found');
  await verifyPostAccess(post, userId);

  const existing = await prisma.postBookmark.findUnique({
    where: { postId_userId: { postId, userId } },
  });

  if (existing) {
    await prisma.postBookmark.delete({ where: { id: existing.id } });
    return { bookmarked: false };
  }

  await prisma.postBookmark.create({ data: { postId, userId } });
  return { bookmarked: true };
}

/**
 * Get bookmarked posts for a user.
 */
export async function getBookmarkedPosts(userId: string, cursor?: string, limit = 20) {
  const where: any = { userId };
  if (cursor) {
    const cursorBookmark = await prisma.postBookmark.findUnique({ where: { id: cursor } });
    if (cursorBookmark) where.createdAt = { lt: cursorBookmark.createdAt };
  }

  const bookmarks = await prisma.postBookmark.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      post: {
        include: {
          ...postInclude,
          likes: { where: { userId }, select: { id: true }, take: 1 },
          bookmarks: { where: { userId }, select: { id: true }, take: 1 },
        },
      },
    },
  });

  const hasMore = bookmarks.length > limit;
  const items = hasMore ? bookmarks.slice(0, limit) : bookmarks;

  return {
    posts: items
      .filter((b) => b.post.isPublished)
      .map((b) => ({ ...formatPost(b.post, userId), bookmarked: true })),
    hasMore,
    cursor: items.length > 0 ? items[items.length - 1].id : null,
  };
}

/**
 * Notify users who were tagged in a post.
 */
async function notifyTaggedUsers(userIds: string[], authorId: string, postId: string, channelId: string) {
  const [author, channel] = await Promise.all([
    prisma.user.findUnique({ where: { id: authorId }, select: { displayName: true } }),
    prisma.conversation.findUnique({ where: { id: channelId }, select: { name: true } }),
  ]);
  const authorName = author?.displayName ?? 'Someone';
  const channelName = channel?.name ?? 'a channel';

  for (const userId of userIds) {
    if (userId === authorId) continue;
    createNotification({
      userId,
      type: 'POST_MENTION',
      title: `${authorName} mentioned you`,
      body: `You were tagged in a post on ${channelName}`,
      data: { postId, channelId, authorId },
    }).catch(() => {});
  }
}

/**
 * Get scheduled (unpublished) posts for a channel. Admin only.
 */
export async function getScheduledPosts(channelId: string, userId: string) {
  await verifyChannelAdmin(channelId, userId);

  const posts = await prisma.post.findMany({
    where: { channelId, isPublished: false, scheduledAt: { not: null } },
    include: { ...postInclude, media: { orderBy: { position: 'asc' } } },
    orderBy: { scheduledAt: 'asc' },
  });

  return posts.map((p) => formatPost(p, userId));
}

/**
 * Publish all scheduled posts whose scheduledAt has passed.
 * Called periodically by a cron job or interval.
 */
export async function publishScheduledPosts() {
  const now = new Date();
  const posts = await prisma.post.findMany({
    where: {
      isPublished: false,
      scheduledAt: { not: null, lte: now },
    },
    select: { id: true, channelId: true, authorId: true, content: true },
  });

  if (posts.length === 0) return;

  await prisma.post.updateMany({
    where: { id: { in: posts.map((p) => p.id) } },
    data: { isPublished: true },
  });

  // Notify subscribers for each published post
  for (const post of posts) {
    notifyChannelFollowers(post.channelId, post.authorId, post.id, post.content ?? '').catch((err) =>
      logger.error({ err, postId: post.id }, 'Failed to notify for scheduled post'));
  }

  logger.info({ count: posts.length }, 'Published scheduled posts');
}

/**
 * Delete a scheduled (unpublished) post. Admin only.
 */
export async function deleteScheduledPost(postId: string, userId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { channelId: true, isPublished: true, scheduledAt: true },
  });
  if (!post) throw new NotFoundError('Post not found');
  if (post.isPublished) throw new ForbiddenError('Cannot delete a published post this way');

  await verifyChannelAdmin(post.channelId, userId);

  await prisma.post.delete({ where: { id: postId } });
  logger.info({ postId, userId }, 'Scheduled post deleted');
  return { deleted: true };
}
