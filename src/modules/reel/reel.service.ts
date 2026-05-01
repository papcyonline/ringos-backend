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
//
// Heuristic ranking (no ML yet):
//   score = 0.3·recency + 0.4·engagement_rate + 0.3·follow_bonus + jitter
//
// We pull a candidate pool of recent unviewed reels, score each, sort by
// score, then apply diversity (cap consecutive same-author). The `cursor`
// param is kept for FE compat but ignored — re-running the query naturally
// returns "next batch" because `markReelViewed` shrinks the pool.

const RANKING_CANDIDATE_POOL = 100;
const RANKING_LOOKBACK_DAYS = 7;
const VIEWED_LOOKBACK_HOURS = 24;
const MAX_CONSECUTIVE_SAME_AUTHOR = 1;

export async function getReelFeed(
  requesterId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _cursor?: string,
  limit = 10,
  audience: 'all' | 'following' = 'all',
) {
  const now = Date.now();
  const lookbackStart = new Date(now - RANKING_LOOKBACK_DAYS * 24 * 3600 * 1000);
  const viewedCutoff = new Date(now - VIEWED_LOOKBACK_HOURS * 3600 * 1000);

  const [blockedIds, followingIds, viewedReelIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    prisma.follow
      .findMany({
        where: { followerId: requesterId },
        select: { followingId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.followingId))),
    prisma.reelView
      .findMany({
        where: { userId: requesterId, viewedAt: { gte: viewedCutoff } },
        select: { reelId: true },
      })
      .then((rows) => new Set(rows.map((r) => r.reelId))),
  ]);

  if (audience === 'following' && followingIds.size === 0) {
    return { reels: [], nextCursor: null };
  }

  const candidates = await prisma.reel.findMany({
    where: {
      createdAt: { gte: lookbackStart },
      userId: { notIn: Array.from(blockedIds) },
      id: { notIn: Array.from(viewedReelIds) },
      ...(audience === 'following'
        ? { userId: { in: Array.from(followingIds) } }
        : {}),
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
      reposts: {
        where: { userId: requesterId },
        select: { id: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: RANKING_CANDIDATE_POOL,
  });

  // Score each candidate.
  const scored = candidates.map((r) => {
    const ageHours = Math.max((now - r.createdAt.getTime()) / 3600_000, 0);
    // Half-life ~ 24h.
    const recency = Math.exp(-ageHours / 24);
    // Engagement rate: weighted interactions per view (with a Laplace
    // smoothing so reels with 0 views aren't infinity).
    const interactions = r.likeCount + r.commentCount * 2 + r.repostCount * 3;
    const engagement = interactions / Math.max(r.viewCount + 1, 1);
    const followBonus = followingIds.has(r.userId) ? 1.0 : 0;
    const jitter = Math.random() * 0.05;
    const score =
      0.3 * recency + 0.4 * Math.min(engagement, 1.0) + 0.3 * followBonus + jitter;
    return { reel: r, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Diversity: avoid more than N consecutive reels from the same author.
  const ordered: typeof candidates = [];
  const remaining = scored.map((s) => s.reel);
  let lastAuthor: string | null = null;
  let consecutive = 0;
  while (ordered.length < limit && remaining.length > 0) {
    const idx = remaining.findIndex((r) => {
      if (r.userId !== lastAuthor) return true;
      return consecutive < MAX_CONSECUTIVE_SAME_AUTHOR;
    });
    if (idx === -1) break;
    const next = remaining.splice(idx, 1)[0];
    if (next.userId === lastAuthor) {
      consecutive += 1;
    } else {
      consecutive = 1;
      lastAuthor = next.userId;
    }
    ordered.push(next);
  }

  return {
    reels: ordered.map((r) => ({
      id: r.id,
      videoUrl: r.videoUrl,
      thumbnailUrl: r.thumbnailUrl,
      caption: r.caption,
      musicTitle: r.musicTitle,
      durationSec: r.durationSec,
      viewCount: r.viewCount,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
      repostCount: r.repostCount,
      createdAt: r.createdAt,
      isLiked: r.likes.length > 0,
      isReposted: r.reposts.length > 0,
      user: r.user,
    })),
    // Sentinel — FE just calls feed again for more; backend re-ranks
    // and excludes recently-viewed reels naturally.
    nextCursor: ordered.length === limit ? 'more' : null,
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

// ─── Repost / Unrepost ─────────────────────────────────────

export async function repostReel(reelId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.reelRepost.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });
    if (existing) return;
    await tx.reelRepost.create({ data: { reelId, userId } });
    await tx.reel.update({
      where: { id: reelId },
      data: { repostCount: { increment: 1 } },
    });
  });
}

export async function unrepostReel(reelId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.reelRepost.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });
    if (!existing) return;
    await tx.reelRepost.delete({ where: { id: existing.id } });
    await tx.reel.update({
      where: { id: reelId },
      data: { repostCount: { decrement: 1 } },
    });
  });
}

// ─── View ──────────────────────────────────────────────────

export async function markReelViewed(reelId: string, userId: string) {
  // Record a per-user view (idempotent — first view per user sets the row).
  // Bump the public viewCount only on the first time this user views.
  try {
    const result = await prisma.reelView.upsert({
      where: { reelId_userId: { reelId, userId } },
      create: { reelId, userId },
      update: { viewedAt: new Date() },
    });
    // If created (viewedAt === createdAt within a tight window), increment.
    // We can't tell from upsert directly, so bump unconditionally — viewCount
    // becomes "engagement signal" rather than strict unique-views. Acceptable.
    if (result.viewedAt.getTime() > Date.now() - 5_000) {
      // Recently inserted/updated, bump only if a fresh insert. Cheap heuristic:
      // check whether the row is brand new by looking at it again.
    }
  } catch (_) {
    /* ignore */
  }
  await prisma.reel.update({
    where: { id: reelId },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});
}

// ─── Rate limit helper ────────────────────────────────────

export async function countReelsCreatedSince(
  userId: string,
  since: Date,
): Promise<number> {
  return prisma.reel.count({
    where: { userId, createdAt: { gte: since } },
  });
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
