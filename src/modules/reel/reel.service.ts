import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { fileToReelVideoUrl } from '../../shared/upload';
import * as cloudinaryService from '../../shared/cloudinary.service';
import { getBlockedUserIds } from '../spotlight/spotlight.service';

// ─── Create Reel ───────────────────────────────────────────

export async function createReel(
  userId: string,
  file: Express.Multer.File,
  options: {
    caption?: string;
    musicTitle?: string;
    durationSec?: number;
  } = {},
) {
  if (!file) {
    throw new BadRequestError('Video file is required');
  }
  // Cap duration at 60s so we don't end up with long videos in the reels feed.
  if (options.durationSec != null && options.durationSec > 60) {
    throw new BadRequestError('Reels must be 60 seconds or less');
  }

  const upload = await fileToReelVideoUrl(file, userId);

  const reel = await prisma.reel.create({
    data: {
      userId,
      videoUrl: upload.secureUrl,
      cloudinaryId: upload.publicId || null,
      thumbnailUrl: upload.thumbnailUrl,
      caption: options.caption?.trim() || null,
      musicTitle: options.musicTitle?.trim() || null,
      durationSec: options.durationSec ?? null,
    },
  });

  logger.info({ reelId: reel.id, userId }, 'Reel created');
  return reel;
}

// ─── Feed ──────────────────────────────────────────────────

export async function getReelFeed(
  requesterId: string,
  cursor?: string,
  limit = 10,
) {
  const blockedIds = await getBlockedUserIds(requesterId);

  const reels = await prisma.reel.findMany({
    where: {
      userId: { notIn: Array.from(blockedIds) },
    },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
      likes: {
        where: { userId: requesterId },
        select: { id: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = reels.length > limit;
  const items = hasMore ? reels.slice(0, limit) : reels;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return {
    reels: items.map((r) => ({
      id: r.id,
      videoUrl: r.videoUrl,
      thumbnailUrl: r.thumbnailUrl,
      caption: r.caption,
      musicTitle: r.musicTitle,
      durationSec: r.durationSec,
      viewCount: r.viewCount,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
      createdAt: r.createdAt,
      isLiked: r.likes.length > 0,
      user: r.user,
    })),
    nextCursor,
  };
}

// ─── Like / Unlike ─────────────────────────────────────────

export async function likeReel(reelId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.reelLike.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });
    if (existing) return;
    await tx.reelLike.create({ data: { reelId, userId } });
    await tx.reel.update({
      where: { id: reelId },
      data: { likeCount: { increment: 1 } },
    });
  });
}

export async function unlikeReel(reelId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.reelLike.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });
    if (!existing) return;
    await tx.reelLike.delete({ where: { id: existing.id } });
    await tx.reel.update({
      where: { id: reelId },
      data: { likeCount: { decrement: 1 } },
    });
  });
}

// ─── View ──────────────────────────────────────────────────

export async function markReelViewed(reelId: string) {
  await prisma.reel.update({
    where: { id: reelId },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});
}

// ─── Delete ────────────────────────────────────────────────

export async function deleteReel(reelId: string, userId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { userId: true, cloudinaryId: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');
  if (reel.userId !== userId) throw new ForbiddenError('Not your reel');

  await prisma.reel.delete({ where: { id: reelId } });
  if (reel.cloudinaryId) {
    cloudinaryService.deleteFile(reel.cloudinaryId, 'video').catch(() => {});
  }
}
