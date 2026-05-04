import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';
import {
  isR2Configured,
  uploadToR2WithKey,
  deleteFromR2,
} from '../../shared/r2.service';
import { moderateVideoUrl } from '../../shared/moderation.service';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import {
  isCloudinaryConfigured,
  uploadUrl as uploadUrlToCloudinary,
} from '../../shared/cloudinary.service';
import * as cache from '../../shared/redis.service';

// ─── Create Reel ───────────────────────────────────────────

export async function createReel(
  userId: string,
  file: Express.Multer.File,
  options: {
    caption?: string;
    musicTitle?: string;
    /// iTunes 30-sec preview URL the viewer plays under the reel.
    musicPreviewUrl?: string;
    musicArtist?: string;
    musicArtwork?: string;
    durationSec?: number;
    /// Viewer-side edits (filter/overlays/speed) — stored as-is.
    videoEdits?: Record<string, unknown>;
  } = {},
) {
  if (!file) {
    throw new BadRequestError('Video file is required');
  }
  if (!isR2Configured) {
    throw new BadRequestError('Video storage is not configured');
  }
  // Cap duration at 60s so we don't end up with long videos in the reels feed.
  // Allow 2s tolerance — on-device compression aligns to keyframes and may
  // report 60.5s for a clean 60s trim.
  if (options.durationSec != null && options.durationSec > 62) {
    throw new BadRequestError('Reels must be 60 seconds or less');
  }

  const upload = await uploadToR2WithKey(
    file.buffer,
    `reels/${userId}`,
    file.originalname || 'reel.mp4',
    file.mimetype || 'video/mp4',
  );

  // Sightengine moderation — sample frames for nudity/offensive/weapon content.
  // If unsafe, delete the just-uploaded object so we don't leak storage.
  const moderation = await moderateVideoUrl(upload.url);
  if (!moderation.safe) {
    await deleteFromR2(upload.key).catch(() => {});
    const err: any = new BadRequestError(
      moderation.reason || 'Video failed content moderation',
    );
    err.code = 'MODERATION_REJECTED';
    throw err;
  }

  // Send the R2-hosted file through Cloudinary's video pipeline so the
  // playback URL has (a) the moov atom moved to the front of the file
  // (faststart) — without this, video_player must download ~the whole MP4
  // before the first frame renders, which is exactly the multi-second
  // black screen users were hitting on tab open — and (b) a derived
  // first-frame thumbnail so the FE has something to show while bytes
  // arrive. If Cloudinary isn't configured or the upload fails we fall
  // back to the raw R2 URL with no thumbnail (existing behavior).
  let videoUrl = upload.url;
  let thumbnailUrl: string | null = null;
  if (isCloudinaryConfigured) {
    try {
      const cdn = await uploadUrlToCloudinary(upload.url, {
        folder: `yomeet/reels/${userId}`,
        resourceType: 'video',
      });
      if (cdn?.secureUrl) {
        videoUrl = cdn.secureUrl;
        // Cloudinary serves a JPEG of frame 0 by swapping the extension.
        thumbnailUrl = cdn.secureUrl.replace(
          /\.(mp4|mov|webm|m4v)(\?.*)?$/i,
          '.jpg$2',
        );
      }
    } catch (err) {
      logger.warn(
        { err, userId },
        'Cloudinary reel processing failed, falling back to R2 URL',
      );
    }
  }

  const reel = await prisma.reel.create({
    data: {
      userId,
      videoUrl,
      // Reusing this column to store the R2 storage key for cleanup.
      cloudinaryId: upload.key,
      thumbnailUrl,
      caption: options.caption?.trim() || null,
      musicTitle: options.musicTitle?.trim() || null,
      musicPreviewUrl: options.musicPreviewUrl?.trim() || null,
      musicArtist: options.musicArtist?.trim() || null,
      musicArtwork: options.musicArtwork?.trim() || null,
      durationSec: options.durationSec ?? null,
      videoEdits: (options.videoEdits as any) ?? undefined,
    },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true, isVerified: true } },
    },
  });

  // The user just posted, so any cached "all/following/mine" feed for them
  // (and their followers, eventually) is stale. We only have to invalidate
  // the requester's own feed cache here — followers' caches expire on their
  // own short TTL. Cheap insurance so the new reel shows up immediately
  // when the FE prepends and the next refresh fires.
  await invalidateReelFeedCache(userId).catch(() => {});

  logger.info({ reelId: reel.id, userId }, 'Reel created');
  return {
    id: reel.id,
    videoUrl: reel.videoUrl,
    thumbnailUrl: reel.thumbnailUrl,
    caption: reel.caption,
    musicTitle: reel.musicTitle,
    musicPreviewUrl: reel.musicPreviewUrl,
    musicArtist: reel.musicArtist,
    musicArtwork: reel.musicArtwork,
    durationSec: reel.durationSec,
    viewCount: reel.viewCount,
    likeCount: reel.likeCount,
    commentCount: reel.commentCount,
    repostCount: reel.repostCount,
    createdAt: reel.createdAt,
    videoEdits: reel.videoEdits,
    isLiked: false,
    isReposted: false,
    user: reel.user,
  };
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

// 30s TTL for the first-page feed. Short enough that newly-viewed reels
// cycle out quickly; long enough to absorb the burst of requests when a
// user opens the tab on a cold backend (the pre-warm + tab tap can fire
// the same query within seconds). Cursor-paginated requests bypass the
// cache because they're meant to advance past the cached page.
const REEL_FEED_CACHE_TTL_SEC = 30;

function reelFeedCacheKey(
  requesterId: string,
  audience: 'all' | 'following' | 'mine',
  limit: number,
) {
  return `reels:feed:${requesterId}:${audience}:${limit}`;
}

export async function invalidateReelFeedCache(requesterId: string) {
  await cache.delPattern(`reels:feed:${requesterId}:*`);
}

export async function getReelFeed(
  requesterId: string,
  cursor?: string,
  limit = 10,
  audience: 'all' | 'following' | 'mine' = 'all',
) {
  // First page is cacheable (30s) — see REEL_FEED_CACHE_TTL_SEC. We skip the
  // cache when the FE asks for "more" because the response would otherwise
  // duplicate the first page (the backend ignores cursors and re-runs the
  // ranking, so cache hits would freeze pagination at the same 10 reels).
  const cacheKey = reelFeedCacheKey(requesterId, audience, limit);
  if (!cursor) {
    const cached = await cache.get<{
      reels: unknown[];
      nextCursor: string | null;
    }>(cacheKey, true);
    if (cached) return cached;
  }

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
    const empty = { reels: [], nextCursor: null };
    if (!cursor) await cache.set(cacheKey, empty, REEL_FEED_CACHE_TTL_SEC);
    return empty;
  }

  // 'mine' is a focused query: just the requester's own reels, all-time-new
  // first. No view-filter, no follow-filter, no ranking — chronological.
  if (audience === 'mine') {
    const mine = await prisma.reel.findMany({
      where: { userId: requesterId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
            isVerified: true,
          },
        },
        likes: { where: { userId: requesterId }, select: { id: true } },
        reposts: { where: { userId: requesterId }, select: { id: true } },
      },
    });
    const result = {
      reels: mine.map((r) => ({
        id: r.id,
        videoUrl: r.videoUrl,
        thumbnailUrl: r.thumbnailUrl,
        caption: r.caption,
        musicTitle: r.musicTitle,
        musicPreviewUrl: r.musicPreviewUrl,
        musicArtist: r.musicArtist,
        musicArtwork: r.musicArtwork,
        durationSec: r.durationSec,
        viewCount: r.viewCount,
        likeCount: r.likeCount,
        commentCount: r.commentCount,
        repostCount: r.repostCount,
        createdAt: r.createdAt,
        videoEdits: r.videoEdits,
        isLiked: r.likes.length > 0,
        isReposted: r.reposts.length > 0,
        user: r.user,
      })),
      nextCursor: null,
    };
    if (!cursor) await cache.set(cacheKey, result, REEL_FEED_CACHE_TTL_SEC);
    return result;
  }

  const candidates = await prisma.reel.findMany({
    where: {
      createdAt: { gte: lookbackStart },
      userId: { notIn: Array.from(blockedIds) },
      ...(audience === 'following'
        ? { userId: { in: Array.from(followingIds) } }
        : {}),
      // Hide reels the requester already watched in the last 24h —
      // EXCEPT their own reels, which should always surface for them.
      OR: [
        { id: { notIn: Array.from(viewedReelIds) } },
        { userId: requesterId },
      ],
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

  const result = {
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
      videoEdits: r.videoEdits,
      isLiked: r.likes.length > 0,
      isReposted: r.reposts.length > 0,
      user: r.user,
    })),
    // Sentinel — FE just calls feed again for more; backend re-ranks
    // and excludes recently-viewed reels naturally.
    nextCursor: ordered.length === limit ? 'more' : null,
  };
  if (!cursor) await cache.set(cacheKey, result, REEL_FEED_CACHE_TTL_SEC);
  return result;
}

// ─── Reactions ─────────────────────────────────────────────
// Same allow-list as stories so the FE can share its emoji burst sheet
// across reels and stories. Single-row-per-user upsert: a second react
// replaces the prior emoji rather than stacking.

import { ALLOWED_REACTION_EMOJIS } from '../story/story.service';

const ALLOWED_REEL_REACTIONS = new Set<string>(ALLOWED_REACTION_EMOJIS);

export async function reactToReel(
  reelId: string,
  userId: string,
  emoji: string,
): Promise<{ emoji: string } | null> {
  if (!ALLOWED_REEL_REACTIONS.has(emoji)) {
    throw new BadRequestError('Invalid reaction emoji');
  }
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { id: true },
  });
  if (!reel) return null;

  await prisma.reelReaction.upsert({
    where: { reelId_userId: { reelId, userId } },
    create: { reelId, userId, emoji },
    update: { emoji },
  });
  return { emoji };
}

export async function clearReelReaction(reelId: string, userId: string) {
  await prisma.reelReaction.deleteMany({ where: { reelId, userId } });
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

export async function markReelViewed(
  reelId: string,
  userId: string,
  progress: { watchedSec?: number; completed?: boolean } = {},
) {
  const watchedSec = Math.max(0, Math.floor(progress.watchedSec ?? 0));
  const completed = progress.completed ?? false;

  // First view per user: create ReelView row + increment public viewCount.
  // Repeat view: keep best-known watch progress (max watchedSec, sticky completed).
  try {
    await prisma.reelView.create({
      data: { reelId, userId, watchedSec, completed },
    });
    await prisma.reel.update({
      where: { id: reelId },
      data: { viewCount: { increment: 1 } },
    });
  } catch (e: any) {
    // P2002 = unique constraint (viewer already counted). Update progress
    // monotonically so partial → full watch is captured but not regressed.
    if (e?.code !== 'P2002') return;
    const existing = await prisma.reelView
      .findUnique({
        where: { reelId_userId: { reelId, userId } },
        select: { watchedSec: true, completed: true },
      })
      .catch(() => null);
    if (!existing) return;
    await prisma.reelView
      .update({
        where: { reelId_userId: { reelId, userId } },
        data: {
          viewedAt: new Date(),
          watchedSec: Math.max(existing.watchedSec, watchedSec),
          completed: existing.completed || completed,
        },
      })
      .catch(() => {});
  }
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
  await invalidateReelFeedCache(userId).catch(() => {});
}
