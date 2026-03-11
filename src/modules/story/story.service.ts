import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import { fileToStoryImageUrl } from '../../shared/upload';
import * as cloudinaryService from '../../shared/cloudinary.service';

// ─── Create Story ───────────────────────────────────────────

export async function createStory(userId: string, files: Express.Multer.File[]) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const uploads = await Promise.all(
    files.map((file, index) =>
      fileToStoryImageUrl(file, userId).then((result) => ({
        imageUrl: result.secureUrl,
        cloudinaryId: result.publicId,
        position: index,
      }))
    )
  );

  const story = await prisma.story.create({
    data: {
      userId,
      expiresAt,
      images: {
        create: uploads,
      },
    },
    include: { images: true },
  });

  logger.info({ storyId: story.id, userId, imageCount: files.length }, 'Story created');
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
      images: { orderBy: { position: 'asc' } },
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
      images: s.images.map((img) => ({
        id: img.id,
        imageUrl: img.imageUrl,
        position: img.position,
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

// ─── Delete Story ───────────────────────────────────────────

export async function deleteStory(storyId: string, userId: string) {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    include: { images: true },
  });

  if (!story) return { deleted: false, reason: 'not_found' };
  if (story.userId !== userId) return { deleted: false, reason: 'not_owner' };

  // Delete cloudinary images
  for (const image of story.images) {
    if (image.cloudinaryId) {
      await cloudinaryService.deleteFile(image.cloudinaryId);
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
    include: { images: { select: { cloudinaryId: true } } },
  });

  if (expired.length === 0) return 0;

  // Collect cloudinary IDs and batch delete
  const cloudinaryIds = expired
    .flatMap((s) => s.images.map((img) => img.cloudinaryId))
    .filter((id) => id !== '');

  for (const publicId of cloudinaryIds) {
    await cloudinaryService.deleteFile(publicId);
  }

  const result = await prisma.story.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  return result.count;
}
