import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { ForbiddenError } from '../../shared/errors';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import { isPro } from '../../shared/usage.service';
import { fileToStoryImageUrl, fileToStoryVideoUrl } from '../../shared/upload';
import * as cloudinaryService from '../../shared/cloudinary.service';
import { getBoostedStoryIds } from './story-boost.service';

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
}

// ─── Create Story ───────────────────────────────────────────

export async function createStory(
  userId: string,
  files: Express.Multer.File[],
  slidesMetadata?: SlideMetadata[],
  options?: { isPermanent?: boolean; channelId?: string },
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
      slides: {
        create: uploads,
      },
    },
    include: { slides: { orderBy: { position: 'asc' } } },
  });

  logger.info({ storyId: story.id, userId, slideCount: files.length }, 'Story created');
  invalidateFeedCache(); // New story affects everyone's feed
  return story;
}

// ─── Get Story Feed ─────────────────────────────────────────

export async function getStoryFeed(requesterId: string) {
  // Return cached feed if still fresh
  const cached = feedCache.get(requesterId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const [blockedIds, boostedStoryIds, subscribedChannelIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getBoostedStoryIds(),
    prisma.conversationParticipant.findMany({
      where: { userId: requesterId, leftAt: null, conversation: { isChannel: true, status: 'ACTIVE' } },
      select: { conversationId: true },
    }).then((subs) => subs.map((s) => s.conversationId)),
  ]);
  const now = new Date();

  const stories = await prisma.story.findMany({
    where: {
      OR: [{ expiresAt: { gt: now } }, { isPermanent: true }],
      userId: { notIn: Array.from(blockedIds) },
      // Include personal stories + channel stories from subscribed channels
      AND: {
        OR: [
          { channelId: null }, // personal stories
          { channelId: { in: subscribedChannelIds } }, // channel stories
        ],
      },
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
      channel: {
        select: { id: true, name: true, avatarUrl: true, isVerified: true },
      },
      views: {
        where: { viewerId: requesterId },
        select: { id: true, liked: true },
      },
      _count: { select: { views: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Group stories by user (or by channel for channel stories)
  const userMap = new Map<string, {
    userId: string;
    channelId?: string;
    displayName: string;
    avatarUrl: string | null;
    isVerified: boolean;
    isOfficial: boolean;
    isChannel: boolean;
    stories: typeof stories;
    hasUnviewed: boolean;
    latestCreatedAt: Date;
    hasBoosted: boolean;
    bestBoostTier: string | null;
  }>();

  for (const story of stories) {
    // Use channelId as grouping key for channel stories, userId for personal
    const key = story.channelId ?? story.userId;
    const hasViewed = story.views.length > 0;
    const boostTier = boostedStoryIds.get(story.id) || null;
    const isChannelStory = !!story.channelId;

    if (!userMap.has(key)) {
      userMap.set(key, {
        userId: story.userId,
        ...(isChannelStory ? { channelId: story.channelId! } : {}),
        displayName: isChannelStory ? (story.channel?.name ?? 'Channel') : story.user.displayName,
        avatarUrl: isChannelStory ? (story.channel?.avatarUrl ?? null) : story.user.avatarUrl,
        isVerified: isChannelStory ? (story.channel?.isVerified ?? false) : story.user.isVerified,
        isOfficial: !isChannelStory && story.user.verifiedRole === 'official',
        isChannel: isChannelStory,
        stories: [],
        hasUnviewed: false,
        latestCreatedAt: story.createdAt,
        hasBoosted: false,
        bestBoostTier: null,
      });
    }

    const entry = userMap.get(key)!;
    entry.stories.push(story);
    if (!hasViewed) entry.hasUnviewed = true;
    if (story.createdAt > entry.latestCreatedAt) {
      entry.latestCreatedAt = story.createdAt;
    }
    if (boostTier) {
      entry.hasBoosted = true;
      if (boostTier === 'premium' || !entry.bestBoostTier) {
        entry.bestBoostTier = boostTier;
      }
    }
  }

  const feed = Array.from(userMap.values()).map((entry) => ({
    userId: entry.userId,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    isVerified: entry.isVerified,
    isOfficial: entry.isOfficial,
    hasUnviewed: entry.hasUnviewed,
    isBoosted: entry.hasBoosted,
    boostTier: entry.bestBoostTier,
    stories: entry.stories.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      isBoosted: boostedStoryIds.has(s.id),
      boostTier: boostedStoryIds.get(s.id) || null,
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
      liked: s.views.some((v) => v.liked),
      viewCount: s._count.views,
    })),
  }));

  // Sort: boosted (premium > basic) → official → unviewed → most recent
  feed.sort((a, b) => {
    // Boosted stories first
    if (a.isBoosted !== b.isBoosted) return a.isBoosted ? -1 : 1;
    if (a.isBoosted && b.isBoosted) {
      if (a.boostTier !== b.boostTier) return a.boostTier === 'premium' ? -1 : 1;
    }
    if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;
    if (a.hasUnviewed !== b.hasUnviewed) return a.hasUnviewed ? -1 : 1;
    return b.stories[0].createdAt.getTime() - a.stories[0].createdAt.getTime();
  });

  // Cache the result
  feedCache.set(requesterId, { data: feed, expiresAt: Date.now() + FEED_CACHE_TTL_MS });

  return feed;
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

// ─── Like Story ────────────────────────────────────────────

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
  // Invalidate feed cache so the liked state is fresh on next fetch
  invalidateFeedCache(viewerId);
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
