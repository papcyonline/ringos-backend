import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';
import {
  isR2Configured,
  uploadToR2WithKey,
  deleteFromR2,
} from '../../shared/r2.service';
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
  if (!isR2Configured) {
    throw new BadRequestError('Video storage is not configured');
  }
  // Cap duration at 60s so we don't end up with long videos in the reels feed.
  if (options.durationSec != null && options.durationSec > 60) {
    throw new BadRequestError('Reels must be 60 seconds or less');
  }

  const upload = await uploadToR2WithKey(
    file.buffer,
    `reels/${userId}`,
    file.originalname || 'reel.mp4',
    file.mimetype || 'video/mp4',
  );

  // R2 doesn't auto-generate thumbnails — FE renders the first frame via
  // VideoPlayer until we add a server-side thumbnail step.
  const reel = await prisma.reel.create({
    data: {
      userId,
      videoUrl: upload.url,
      // Reusing this column to store the R2 storage key for cleanup.
      cloudinaryId: upload.key,
      thumbnailUrl: null,
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

// ─── Comments ──────────────────────────────────────────────

export async function addReelComment(
  reelId: string,
  userId: string,
  content: string,
) {
  const trimmed = content.trim();
  if (!trimmed) throw new BadRequestError('Comment is required');
  if (trimmed.length > 500) throw new BadRequestError('Comment too long');

  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { id: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');

  const comment = await prisma.$transaction(async (tx) => {
    const c = await tx.reelComment.create({
      data: { reelId, userId, content: trimmed },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
            isVerified: true,
          },
        },
      },
    });
    await tx.reel.update({
      where: { id: reelId },
      data: { commentCount: { increment: 1 } },
    });
    return c;
  });
  return comment;
}

export async function getReelComments(
  reelId: string,
  cursor?: string,
  limit = 30,
) {
  const comments = await prisma.reelComment.findMany({
    where: { reelId },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = comments.length > limit;
  const items = hasMore ? comments.slice(0, limit) : comments;
  return {
    comments: items.map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      user: c.user,
    })),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

export async function deleteReelComment(commentId: string, userId: string) {
  const c = await prisma.reelComment.findUnique({
    where: { id: commentId },
    select: { userId: true, reelId: true },
  });
  if (!c) throw new NotFoundError('Comment not found');
  if (c.userId !== userId) throw new ForbiddenError('Not your comment');

  await prisma.$transaction(async (tx) => {
    await tx.reelComment.delete({ where: { id: commentId } });
    await tx.reel.update({
      where: { id: c.reelId },
      data: { commentCount: { decrement: 1 } },
    });
  });
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
    deleteFromR2(reel.cloudinaryId).catch((err) => {
      logger.warn({ err, key: reel.cloudinaryId }, 'Failed to delete reel from R2');
    });
  }
}
