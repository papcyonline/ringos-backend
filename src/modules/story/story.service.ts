import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError } from '../../shared/errors';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import { isPro } from '../../shared/usage.service';
import { fileToStoryImageUrl, fileToStoryVideoUrl } from '../../shared/upload';
import * as cloudinaryService from '../../shared/cloudinary.service';
import { getOrCreateDirectConversation, sendMessage } from '../chat/chat.service';
import { notifyFollowersOfNewStory } from './story.notify';

export const ALLOWED_REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥', '👏'] as const;
const ALLOWED_REACTION_SET = new Set<string>(ALLOWED_REACTION_EMOJIS);

// ─── Feed Cache ─────────────────────────────────────────────
// Per-user feed cache with short TTL to avoid hammering the DB on every poll.

interface CachedFeed {
  data: any[];
  expiresAt: number;
}

const feedCache = new Map<string, CachedFeed>();
const FEED_CACHE_TTL_MS = 60_000; // 60 seconds

/** Invalidate all feed caches (call after story create/delete/boost). */
export function invalidateFeedCache(userId?: string) {
  if (userId) {
    feedCache.delete(userId);
  } else {
    feedCache.clear();
  }
}

// ─── Types ──────────────────────────────────────────────────

interface SlideMetadata {
  type: 'IMAGE' | 'VIDEO' | 'TEXT';
  position: number;
  duration?: number;
  caption?: string;
  music?: {
    previewUrl: string;
    title?: string;
    artist?: string;
    artwork?: string;
  };
}

// ─── Create Story ───────────────────────────────────────────

export async function createStory(
  userId: string,
  files: Express.Multer.File[],
  slidesMetadata?: SlideMetadata[],
  options?: {
    isPermanent?: boolean;
    channelId?: string;
    visibility?: 'FRIENDS' | 'PUBLIC';
  },
) {
  // If posting as a channel, verify user is admin
  if (options?.channelId) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: options.channelId, userId } },
    });
    if (!participant || participant.role !== 'ADMIN') {
      throw new ForbiddenError('Only channel admins can post channel stories');
    }
  }

  const pro = await isPro(userId);
  const permanent = options?.isPermanent === true && pro;
  const hoursToExpire = pro ? 48 : 24;
  const expiresAt = permanent
    ? new Date('2099-12-31T23:59:59Z')
    : new Date(Date.now() + hoursToExpire * 60 * 60 * 1000);

  const uploads = await Promise.all(
    files.map(async (file, index) => {
      const meta = slidesMetadata?.[index];
      const slideType = meta?.type ?? 'IMAGE';
      const position = meta?.position ?? index;

      // Prisma JSON fields require `undefined` for "no value" (not null).
      const slideMetadata: Record<string, any> | undefined = meta?.music
        ? { music: meta.music }
        : undefined;
      if (slideType === 'VIDEO') {
        const result = await fileToStoryVideoUrl(file, userId);
        return {
          type: 'VIDEO' as const,
          mediaUrl: result.secureUrl,
          cloudinaryId: result.publicId,
          thumbnailUrl: result.thumbnailUrl || null,
          caption: meta?.caption ?? null,
          duration: meta?.duration ?? null,
          position,
          metadata: slideMetadata ?? undefined,
        };
      } else {
        // IMAGE or TEXT — both use image upload
        const result = await fileToStoryImageUrl(file, userId);
        return {
          type: slideType as 'IMAGE' | 'TEXT',
          mediaUrl: result.secureUrl,
          cloudinaryId: result.publicId,
          thumbnailUrl: null,
          caption: meta?.caption ?? null,
          duration: meta?.duration ?? null,
          position,
          metadata: slideMetadata ?? undefined,
        };
      }
    })
  );

  const story = await prisma.story.create({
    data: {
      userId,
      ...(options?.channelId ? { channelId: options.channelId } : {}),
      expiresAt,
      isPermanent: permanent,
      visibility: options?.visibility === 'PUBLIC' ? 'PUBLIC' : 'FRIENDS',
      slides: {
        create: uploads,
      },
    },
    include: { slides: { orderBy: { position: 'asc' } } },
  });

  logger.info({ storyId: story.id, userId, slideCount: files.length }, 'Story created');
  invalidateFeedCache(); // New story affects everyone's feed
  // Fan-out push notifications to followers — fire-and-forget so the request
  // returns fast. Skipped for channel stories (different audience).
  if (!options?.channelId) {
    notifyFollowersOfNewStory(story.id, userId).catch((err) =>
      logger.warn({ err, storyId: story.id }, 'notifyFollowersOfNewStory failed'),
    );
  }
  return story;
}

// ─── Get Story Feed ─────────────────────────────────────────

export async function getStoryFeed(requesterId: string) {
  const cached = feedCache.get(requesterId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // Friends section = stories of users WHO FOLLOW ME (incoming followers).
  const [blockedIds, followerIds, mutedIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getFollowerIds(requesterId),
    getMutedUserIds(requesterId),
  ]);

  const mutedSet = new Set(mutedIds);
  const audienceIds = [requesterId, ...followerIds].filter(
    (id) => !blockedIds.has(id) && !mutedSet.has(id),
  );
  const now = new Date();

  const stories = await prisma.story.findMany({
    where: {
      userId: { in: audienceIds },
      channelId: null,
      OR: [{ expiresAt: { gt: now } }, { isPermanent: true }],
    },
    include: {
      slides: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          type: true,
          mediaUrl: true,
          thumbnailUrl: true,
          caption: true,
          duration: true,
          position: true,
        },
      },
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
          verifiedRole: true,
        },
      },
      views: {
        where: { viewerId: requesterId },
        select: { id: true },
      },
      reactions: {
        where: { userId: requesterId },
        select: { emoji: true },
      },
      _count: { select: { views: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const byUser = new Map<string, {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    isVerified: boolean;
    isOfficial: boolean;
    isSelf: boolean;
    hasUnviewed: boolean;
    latestCreatedAt: Date;
    stories: typeof stories;
  }>();

  for (const story of stories) {
    let entry = byUser.get(story.userId);
    if (!entry) {
      entry = {
        userId: story.userId,
        displayName: story.user.displayName,
        avatarUrl: story.user.avatarUrl,
        isVerified: story.user.isVerified,
        isOfficial: story.user.verifiedRole === 'official',
        isSelf: story.userId === requesterId,
        hasUnviewed: false,
        latestCreatedAt: story.createdAt,
        stories: [],
      };
      byUser.set(story.userId, entry);
    }
    entry.stories.push(story);
    if (story.views.length === 0 && story.userId !== requesterId) {
      entry.hasUnviewed = true;
    }
    if (story.createdAt > entry.latestCreatedAt) {
      entry.latestCreatedAt = story.createdAt;
    }
  }

  const feed = Array.from(byUser.values()).map((entry) => ({
    userId: entry.userId,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    isVerified: entry.isVerified,
    isOfficial: entry.isOfficial,
    isSelf: entry.isSelf,
    hasUnviewed: entry.hasUnviewed,
    stories: entry.stories.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      slides: s.slides.map((slide) => ({
        id: slide.id,
        type: slide.type,
        mediaUrl: slide.mediaUrl,
        thumbnailUrl: slide.thumbnailUrl,
        caption: slide.caption,
        duration: slide.duration,
        position: slide.position,
      })),
      viewed: s.views.length > 0,
      myReaction: s.reactions[0]?.emoji ?? null,
      viewCount: s._count.views,
    })),
  }));

  // Snapchat-style ranking: self first, then unviewed friends, then most recent
  feed.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.hasUnviewed !== b.hasUnviewed) return a.hasUnviewed ? -1 : 1;
    return b.stories[0].createdAt.getTime() - a.stories[0].createdAt.getTime();
  });

  feedCache.set(requesterId, { data: feed, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
  return feed;
}

// Shared grouping for getStoryFeed / getFollowingFeed / getDiscoverFeed.
// Takes a flat list of stories with the standard include shape and returns
// the public feed payload grouped by user.
function groupStoriesByUser(
  stories: Array<any>,
  requesterId: string,
) {
  const byUser = new Map<string, {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    isVerified: boolean;
    isOfficial: boolean;
    isSelf: boolean;
    hasUnviewed: boolean;
    latestCreatedAt: Date;
    stories: typeof stories;
  }>();

  for (const story of stories) {
    let entry = byUser.get(story.userId);
    if (!entry) {
      entry = {
        userId: story.userId,
        displayName: story.user.displayName,
        avatarUrl: story.user.avatarUrl,
        isVerified: story.user.isVerified,
        isOfficial: story.user.verifiedRole === 'official',
        isSelf: story.userId === requesterId,
        hasUnviewed: false,
        latestCreatedAt: story.createdAt,
        stories: [],
      };
      byUser.set(story.userId, entry);
    }
    entry.stories.push(story);
    if (story.views.length === 0 && story.userId !== requesterId) {
      entry.hasUnviewed = true;
    }
    if (story.createdAt > entry.latestCreatedAt) {
      entry.latestCreatedAt = story.createdAt;
    }
  }

  return Array.from(byUser.values()).map((entry) => ({
    userId: entry.userId,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    isVerified: entry.isVerified,
    isOfficial: entry.isOfficial,
    isSelf: entry.isSelf,
    hasUnviewed: entry.hasUnviewed,
    stories: entry.stories.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      slides: s.slides,
      viewed: s.views.length > 0,
      myReaction: s.reactions[0]?.emoji ?? null,
      viewCount: s._count.views,
    })),
  }));
}

// ─── Get Following Feed ─────────────────────────────────────
// Stories of users I FOLLOW (regardless of whether they follow me back).

export async function getFollowingFeed(requesterId: string) {
  const [blockedIds, followingIds, mutedIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getFollowingIds(requesterId),
    getMutedUserIds(requesterId),
  ]);

  const mutedSet = new Set(mutedIds);
  const audienceIds = followingIds.filter(
    (id) => !blockedIds.has(id) && !mutedSet.has(id),
  );
  if (audienceIds.length === 0) return [];

  const now = new Date();
  const stories = await prisma.story.findMany({
    where: {
      userId: { in: audienceIds },
      channelId: null,
      OR: [{ expiresAt: { gt: now } }, { isPermanent: true }],
    },
    include: {
      slides: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          type: true,
          mediaUrl: true,
          thumbnailUrl: true,
          caption: true,
          duration: true,
          position: true,
        },
      },
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
          verifiedRole: true,
        },
      },
      views: {
        where: { viewerId: requesterId },
        select: { id: true },
      },
      reactions: {
        where: { userId: requesterId },
        select: { emoji: true },
      },
      _count: { select: { views: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return groupStoriesByUser(stories, requesterId);
}

// ─── Get Discover Feed ──────────────────────────────────────
// Stories of users with no follow relationship in either direction.
// Random people — neither I follow them nor they follow me.
// Only PUBLIC-visibility stories surface here.

export async function getDiscoverFeed(requesterId: string) {
  const [blockedIds, followingIds, followerIds, mutedIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getFollowingIds(requesterId),
    getFollowerIds(requesterId),
    getMutedUserIds(requesterId),
  ]);

  const excludeIds = new Set<string>([
    requesterId,
    ...followingIds,
    ...followerIds,
    ...mutedIds,
  ]);
  for (const id of blockedIds) {
    excludeIds.add(id);
  }
  const now = new Date();

  const stories = await prisma.story.findMany({
    where: {
      userId: { notIn: Array.from(excludeIds) },
      channelId: null,
      visibility: 'PUBLIC',
      OR: [{ expiresAt: { gt: now } }, { isPermanent: true }],
    },
    include: {
      slides: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          type: true,
          mediaUrl: true,
          thumbnailUrl: true,
          caption: true,
          duration: true,
          position: true,
        },
      },
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
          verifiedRole: true,
        },
      },
      views: {
        where: { viewerId: requesterId },
        select: { id: true },
      },
      reactions: {
        where: { userId: requesterId },
        select: { emoji: true },
      },
      _count: { select: { views: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return groupStoriesByUser(stories, requesterId);
}

// People who follow me (incoming).
async function getFollowerIds(userId: string): Promise<string[]> {
  const rows = await prisma.follow.findMany({
    where: { followingId: userId },
    select: { followerId: true },
  });
  return rows.map((r) => r.followerId);
}

// People I follow (outgoing).
async function getFollowingIds(userId: string): Promise<string[]> {
  const rows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });
  return rows.map((r) => r.followingId);
}

// Users I've muted from my story feed.
async function getMutedUserIds(userId: string): Promise<string[]> {
  const rows = await prisma.storyMute.findMany({
    where: { muterId: userId },
    select: { mutedUserId: true },
  });
  return rows.map((r) => r.mutedUserId);
}

// ─── Mute / Unmute ──────────────────────────────────────────

export async function muteUserStories(muterId: string, mutedUserId: string) {
  if (muterId === mutedUserId) {
    throw new BadRequestError('Cannot mute yourself');
  }
  await prisma.storyMute.upsert({
    where: { muterId_mutedUserId: { muterId, mutedUserId } },
    create: { muterId, mutedUserId },
    update: {},
  });
  invalidateFeedCache(muterId);
}

export async function unmuteUserStories(muterId: string, mutedUserId: string) {
  await prisma.storyMute.deleteMany({
    where: { muterId, mutedUserId },
  });
  invalidateFeedCache(muterId);
}

// ─── Mark Story Viewed ──────────────────────────────────────

export async function markStoryViewed(storyId: string, viewerId: string, isStealth = false) {
  await prisma.storyView.createMany({
    data: [{ storyId, viewerId, isStealth }],
    skipDuplicates: true,
  });
}

// ─── Get Story Viewers ──────────────────────────────────────

export async function getStoryViewers(storyId: string, userId: string) {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { userId: true },
  });

  if (!story || story.userId !== userId) {
    return null;
  }

  const views = await prisma.storyView.findMany({
    where: { storyId, isStealth: false },
    include: {
      story: false,
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Fetch viewer user info
  const viewerIds = views.map((v) => v.viewerId);
  const users = await prisma.user.findMany({
    where: { id: { in: viewerIds } },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      isVerified: true,
    },
  });

  const userMap = new Map(users.map((u) => [u.id, u]));

  return views.map((v) => {
    const user = userMap.get(v.viewerId);
    return {
      userId: v.viewerId,
      viewedAt: v.createdAt,
      liked: v.liked,
      displayName: user?.displayName ?? 'Unknown',
      avatarUrl: user?.avatarUrl ?? null,
      isVerified: user?.isVerified ?? false,
    };
  });
}

// ─── Like Story (legacy endpoint, kept for old app builds) ─────

export async function likeStory(storyId: string, viewerId: string, liked: boolean = true) {
  const view = await prisma.storyView.findUnique({
    where: { storyId_viewerId: { storyId, viewerId } },
  });

  if (!view) {
    await prisma.storyView.create({
      data: { storyId, viewerId, liked },
    });
  } else {
    await prisma.storyView.update({
      where: { id: view.id },
      data: { liked },
    });
  }

  // Mirror to StoryReaction so the new feed reader sees the like correctly.
  if (liked) {
    await prisma.storyReaction.upsert({
      where: { storyId_userId: { storyId, userId: viewerId } },
      create: { storyId, userId: viewerId, emoji: '❤️' },
      update: { emoji: '❤️' },
    });
  } else {
    await prisma.storyReaction.deleteMany({
      where: { storyId, userId: viewerId },
    });
  }

  invalidateFeedCache(viewerId);
}

// ─── React to Story ────────────────────────────────────────

export async function reactToStory(
  storyId: string,
  userId: string,
  emoji: string,
): Promise<{ emoji: string } | null> {
  if (!ALLOWED_REACTION_SET.has(emoji)) {
    throw new BadRequestError('Invalid reaction emoji');
  }

  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true, userId: true },
  });
  if (!story) return null;

  await prisma.storyReaction.upsert({
    where: { storyId_userId: { storyId, userId } },
    create: { storyId, userId, emoji },
    update: { emoji },
  });

  // Mirror ❤️ into legacy StoryView.liked so old app builds keep showing the like.
  await prisma.storyView.upsert({
    where: { storyId_viewerId: { storyId, viewerId: userId } },
    create: { storyId, viewerId: userId, liked: emoji === '❤️' },
    update: { liked: emoji === '❤️' },
  });

  invalidateFeedCache(userId);
  return { emoji };
}

export async function clearStoryReaction(storyId: string, userId: string) {
  await prisma.storyReaction.deleteMany({
    where: { storyId, userId },
  });
  await prisma.storyView.updateMany({
    where: { storyId, viewerId: userId },
    data: { liked: false },
  });
  invalidateFeedCache(userId);
}

// ─── Reply to Story ────────────────────────────────────────
// Creates (or reuses) a 1-on-1 DM with the story owner and posts the reply
// as a chat message. The slide context is stashed in metadata so the FE can
// render it as a quoted snippet above the reply bubble.

export async function replyToStory(
  storyId: string,
  senderId: string,
  text: string,
): Promise<{ conversationId: string; messageId: string } | null> {
  const trimmed = text.trim();
  if (!trimmed) throw new BadRequestError('Reply text is required');

  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: {
      id: true,
      userId: true,
      slides: {
        select: { id: true, type: true, mediaUrl: true, thumbnailUrl: true },
        orderBy: { position: 'asc' },
        take: 1,
      },
    },
  });
  if (!story) return null;
  if (story.userId === senderId) {
    throw new BadRequestError('Cannot reply to your own story');
  }

  const conversation = await getOrCreateDirectConversation(senderId, story.userId);
  const firstSlide = story.slides[0] ?? null;

  const message = await sendMessage(conversation.id, senderId, trimmed, {
    metadata: {
      storyContext: {
        storyId,
        ownerId: story.userId,
        firstSlide: firstSlide
          ? {
              id: firstSlide.id,
              type: firstSlide.type,
              mediaUrl: firstSlide.mediaUrl,
              thumbnailUrl: firstSlide.thumbnailUrl,
            }
          : null,
      },
    },
  });

  return { conversationId: conversation.id, messageId: message.id };
}

// ─── Update Slide Caption ──────────────────────────────────

export async function updateSlideCaption(slideId: string, userId: string, caption: string | null) {
  const slide = await prisma.storySlide.findUnique({
    where: { id: slideId },
    include: { story: { select: { userId: true } } },
  });

  if (!slide) return { updated: false, reason: 'not_found' as const };
  if (slide.story.userId !== userId) return { updated: false, reason: 'not_owner' as const };

  await prisma.storySlide.update({
    where: { id: slideId },
    data: { caption: caption || null },
  });

  return { updated: true };
}

// ─── Delete Slide ───────────────────────────────────────────

export async function deleteSlide(slideId: string, userId: string) {
  const slide = await prisma.storySlide.findUnique({
    where: { id: slideId },
    include: { story: { select: { id: true, userId: true, _count: { select: { slides: true } } } } },
  });

  if (!slide) return { deleted: false, reason: 'not_found' as const };
  if (slide.story.userId !== userId) return { deleted: false, reason: 'not_owner' as const };

  // Delete from Cloudinary with correct resource type
  if (slide.cloudinaryId) {
    const resourceType = slide.type === 'VIDEO' ? 'video' : 'image';
    await cloudinaryService.deleteFile(slide.cloudinaryId, resourceType);
  }

  // If this is the last slide, delete the entire story
  if (slide.story._count.slides <= 1) {
    await prisma.story.delete({ where: { id: slide.storyId } });
    logger.info({ slideId, storyId: slide.storyId, userId }, 'Last slide deleted, story removed');
    return { deleted: true, storyDeleted: true };
  }

  // Otherwise just delete the slide and reorder positions
  await prisma.storySlide.delete({ where: { id: slideId } });

  // Reorder remaining slides to close the gap
  const remainingSlides = await prisma.storySlide.findMany({
    where: { storyId: slide.storyId },
    orderBy: { position: 'asc' },
    select: { id: true },
  });

  await Promise.all(
    remainingSlides.map((s, idx) =>
      prisma.storySlide.update({ where: { id: s.id }, data: { position: idx } })
    )
  );

  logger.info({ slideId, storyId: slide.storyId, userId }, 'Slide deleted');
  invalidateFeedCache(); // Slide changes affect feed
  return { deleted: true, storyDeleted: false };
}

// ─── Delete Story ───────────────────────────────────────────

export async function deleteStory(storyId: string, userId: string) {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    include: { slides: true },
  });

  if (!story) return { deleted: false, reason: 'not_found' };
  if (story.userId !== userId) return { deleted: false, reason: 'not_owner' };

  // Delete from DB first, then clean up cloudinary (fire-and-forget)
  await prisma.story.delete({ where: { id: storyId } });

  // Clean up cloudinary assets — don't block on failures
  for (const slide of story.slides) {
    if (slide.cloudinaryId) {
      const resourceType = slide.type === 'VIDEO' ? 'video' : 'image';
      cloudinaryService.deleteFile(slide.cloudinaryId, resourceType).catch(() => {});
    }
  }
  logger.info({ storyId, userId }, 'Story deleted');
  invalidateFeedCache(); // Deletion affects everyone's feed
  return { deleted: true };
}

// ─── Cleanup Expired Stories ────────────────────────────────

export async function cleanupExpiredStories(): Promise<number> {
  const now = new Date();

  // Process in batches to avoid loading thousands of stories at once
  const expired = await prisma.story.findMany({
    where: { expiresAt: { lte: now }, isPermanent: false },
    include: { slides: { select: { cloudinaryId: true, type: true } } },
    take: 200,
  });

  if (expired.length === 0) return 0;

  // Delete cloudinary assets — fire concurrently per story to avoid serial N+1
  await Promise.allSettled(
    expired.flatMap((story) =>
      story.slides
        .filter((slide) => slide.cloudinaryId)
        .map((slide) => {
          const resourceType = slide.type === 'VIDEO' ? 'video' : 'image';
          return cloudinaryService.deleteFile(slide.cloudinaryId!, resourceType);
        }),
    ),
  );

  const expiredIds = expired.map((s) => s.id);
  const result = await prisma.story.deleteMany({
    where: { id: { in: expiredIds } },
  });

  if (result.count > 0) {
    invalidateFeedCache(); // Expired stories removed, refresh all feeds
  }

  return result.count;
}
