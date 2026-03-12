import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import { fileToStoryImageUrl, fileToStoryVideoUrl } from '../../shared/upload';
import * as cloudinaryService from '../../shared/cloudinary.service';

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
  slidesMetadata?: SlideMetadata[]
) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

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
      expiresAt,
      slides: {
        create: uploads,
      },
    },
    include: { slides: { orderBy: { position: 'asc' } } },
  });

  logger.info({ storyId: story.id, userId, slideCount: files.length }, 'Story created');
  return story;
}

// ─── Get Story Feed ─────────────────────────────────────────

export async function getStoryFeed(requesterId: string) {
  const blockedIds = await getBlockedUserIds(requesterId);
  const now = new Date();

  const stories = await prisma.story.findMany({
    where: {
      expiresAt: { gt: now },
      userId: { notIn: Array.from(blockedIds) },
    },
    include: {
      slides: { orderBy: { position: 'asc' } },
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
      views: {
        where: { viewerId: requesterId },
        select: { id: true },
      },
      _count: { select: { views: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Group stories by user
  const userMap = new Map<string, {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    isVerified: boolean;
    stories: typeof stories;
    hasUnviewed: boolean;
    latestCreatedAt: Date;
  }>();

  for (const story of stories) {
    const uid = story.userId;
    const hasViewed = story.views.length > 0;

    if (!userMap.has(uid)) {
      userMap.set(uid, {
        userId: uid,
        displayName: story.user.displayName,
        avatarUrl: story.user.avatarUrl,
        isVerified: story.user.isVerified,
        stories: [],
        hasUnviewed: false,
        latestCreatedAt: story.createdAt,
      });
    }

    const entry = userMap.get(uid)!;
    entry.stories.push(story);
    if (!hasViewed) entry.hasUnviewed = true;
    if (story.createdAt > entry.latestCreatedAt) {
      entry.latestCreatedAt = story.createdAt;
    }
  }

  const feed = Array.from(userMap.values()).map((entry) => ({
    userId: entry.userId,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    isVerified: entry.isVerified,
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
      viewCount: s._count.views,
    })),
  }));

  // Sort: unviewed first, then most recent
  feed.sort((a, b) => {
    if (a.hasUnviewed !== b.hasUnviewed) return a.hasUnviewed ? -1 : 1;
    return b.stories[0].createdAt.getTime() - a.stories[0].createdAt.getTime();
  });

  return feed;
}

// ─── Mark Story Viewed ──────────────────────────────────────

export async function markStoryViewed(storyId: string, viewerId: string) {
  await prisma.storyView.createMany({
    data: [{ storyId, viewerId }],
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
    where: { storyId },
    include: {
      story: false,
    },
    orderBy: { createdAt: 'desc' },
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
      displayName: user?.displayName ?? 'Unknown',
      avatarUrl: user?.avatarUrl ?? null,
      isVerified: user?.isVerified ?? false,
    };
  });
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

  // Delete cloudinary assets with correct resource type
  for (const slide of story.slides) {
    if (slide.cloudinaryId) {
      const resourceType = slide.type === 'VIDEO' ? 'video' : 'image';
      await cloudinaryService.deleteFile(slide.cloudinaryId, resourceType);
    }
  }

  await prisma.story.delete({ where: { id: storyId } });
  logger.info({ storyId, userId }, 'Story deleted');
  return { deleted: true };
}

// ─── Cleanup Expired Stories ────────────────────────────────

export async function cleanupExpiredStories(): Promise<number> {
  const now = new Date();

  const expired = await prisma.story.findMany({
    where: { expiresAt: { lte: now } },
    include: { slides: { select: { cloudinaryId: true, type: true } } },
  });

  if (expired.length === 0) return 0;

  // Delete cloudinary assets with correct resource types
  for (const story of expired) {
    for (const slide of story.slides) {
      if (slide.cloudinaryId) {
        const resourceType = slide.type === 'VIDEO' ? 'video' : 'image';
        await cloudinaryService.deleteFile(slide.cloudinaryId, resourceType);
      }
    }
  }

  const result = await prisma.story.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  return result.count;
}
