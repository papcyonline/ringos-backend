import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';
import {
  isR2Configured,
  uploadToR2WithKey,
  deleteFromR2,
  deleteR2Prefix,
} from '../../shared/r2.service';
import { fileToReelHls } from '../../shared/upload';
import { moderateVideoBuffer } from '../../shared/moderation.service';
import {
  createNotification,
  sendPushToUser,
} from '../notification/notification.service';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import { ensureWebSafeH264, extractPosterFrame } from '../../shared/video.service';
import * as cache from '../../shared/redis.service';
import path from 'path';

// ─── Serialization ─────────────────────────────────────────
// One shape for a reel sent to the client. `likes`/`reposts`/`bookmarks` are
// the per-viewer relation includes (filtered to the requester in the query);
// when absent (e.g. right after create) the *is\** flags default to false.
function serializeReel(r: any) {
  return {
    id: r.id,
    videoUrl: r.videoUrl,
    // Adaptive HLS master playlist (null for legacy/failed) — new clients
    // prefer this; old clients ignore it and use videoUrl.
    hlsUrl: r.hlsUrl ?? null,
    thumbnailUrl: r.thumbnailUrl,
    caption: r.caption,
    musicTitle: r.musicTitle,
    musicPreviewUrl: r.musicPreviewUrl,
    musicArtist: r.musicArtist,
    musicArtwork: r.musicArtwork,
    videoVolume: r.videoVolume,
    musicVolume: r.musicVolume,
    durationSec: r.durationSec,
    viewCount: r.viewCount,
    likeCount: r.likeCount,
    commentCount: r.commentCount,
    repostCount: r.repostCount,
    bookmarkCount: r.bookmarkCount,
    createdAt: r.createdAt,
    pinnedAt: r.pinnedAt ?? null,
    isPinned: r.pinnedAt != null,
    videoEdits: r.videoEdits,
    isLiked: (r.likes?.length ?? 0) > 0,
    isReposted: (r.reposts?.length ?? 0) > 0,
    isBookmarked: (r.bookmarks?.length ?? 0) > 0,
    user: r.user,
  };
}

/// Per-viewer relation includes for the *is\** flags, filtered to [userId].
const reelStateInclude = (userId: string) => ({
  likes: { where: { userId }, select: { id: true } },
  reposts: { where: { userId }, select: { id: true } },
  bookmarks: { where: { userId }, select: { id: true } },
});

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
    /// Mix levels 0..1 — null preserves the legacy "music replaces video"
    /// behaviour the viewer falls back to when these are absent.
    videoVolume?: number;
    musicVolume?: number;
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

  // Normalize to a web-safe H.264 MP4 (faststart): H.264 is cheaply remuxed,
  // while iPhone HEVC/HDR/4K is transcoded so it plays everywhere and can be
  // decoded by the moderator. Fail-open: on any ffmpeg error this returns the
  // original buffer unchanged.
  const normalized = await ensureWebSafeH264(
    file.buffer,
    path.extname(file.originalname || '') || '.mp4',
  );

  // Moderation FIRST — sample frames from the normalized buffer (no URL fetch)
  // and check them via OpenAI. Doing this before upload means an unsafe reel
  // never lands the (many) HLS files in storage. Block only on a GENUINE
  // "unsafe" verdict; if moderation was merely unavailable (API down/rate-
  // limited, or a codec we couldn't decode), let the reel through rather than a
  // false guidelines rejection.
  const moderation = await moderateVideoBuffer(normalized, '.mp4');
  if (!moderation.safe && !moderation.unavailable) {
    const err: any = new BadRequestError(
      moderation.reason || 'Video failed content moderation',
    );
    err.code = 'MODERATION_REJECTED';
    throw err;
  }

  // Always store a progressive MP4 (videoUrl) so older app versions that can't
  // play HLS keep working. ADDITIONALLY produce an adaptive HLS ladder
  // (240p/480p/720p) so reels play on slow/2G networks — new clients prefer
  // hlsUrl. HLS is best-effort: on failure the reel still posts (MP4 only).
  const upload = await uploadToR2WithKey(
    normalized,
    `reels/${userId}`,
    'reel.mp4',
    'video/mp4',
  );
  const videoUrl = upload.url;
  const storageKey = upload.key;

  const hls = await fileToReelHls(normalized, userId).catch(() => null);
  const hlsUrl = hls?.url ?? null;
  const hlsKey = hls?.key ?? null;

  // Generate a first-frame JPEG poster server-side (ffmpeg) and store it on R2,
  // so the profile reels grid can show a small still image per tile instead of
  // decoding video per tile (which OOM-kills iOS). Fail-open: on any error the
  // thumbnail stays null and the FE falls back to a placeholder.
  let thumbnailUrl: string | null = null;
  try {
    const poster = await extractPosterFrame(normalized, '.mp4');
    if (poster && poster.length > 0) {
      const posterUpload = await uploadToR2WithKey(
        poster,
        `reels/${userId}/thumbs`,
        'poster.jpg',
        'image/jpeg',
      );
      thumbnailUrl = posterUpload.url;
    }
  } catch (err) {
    logger.warn({ err, userId }, 'Reel poster generation failed — thumbnail null');
  }

  const reel = await prisma.reel.create({
    data: {
      userId,
      videoUrl,
      // MP4 object key (ends in .mp4) — cleanup deletes this object.
      cloudinaryId: storageKey,
      hlsUrl,
      // HLS directory PREFIX — cleanup deletes the whole prefix.
      hlsKey,
      thumbnailUrl,
      caption: options.caption?.trim() || null,
      musicTitle: options.musicTitle?.trim() || null,
      musicPreviewUrl: options.musicPreviewUrl?.trim() || null,
      musicArtist: options.musicArtist?.trim() || null,
      musicArtwork: options.musicArtwork?.trim() || null,
      videoVolume: options.videoVolume ?? null,
      musicVolume: options.musicVolume ?? null,
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
  return serializeReel(reel);
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

/**
 * Reels posted by a specific user, newest first — used by the profile "Reels"
 * tab (your own profile and other users'). Chronological, no ranking. Blocking
 * is honoured both ways: a blocked user's reels are hidden. `isLiked`/`isReposted`
 * reflect the REQUESTER so the viewer's own state is correct.
 */
export async function getUserReels(
  requesterId: string,
  targetUserId: string,
  limit = 30,
) {
  const blockedIds = await getBlockedUserIds(requesterId);
  if (blockedIds.has(targetUserId)) {
    return { reels: [], nextCursor: null };
  }

  const rows = await prisma.reel.findMany({
    where: { userId: targetUserId },
    // Pinned reels first (most-recently-pinned first), then newest. nulls:last
    // so un-pinned reels (null pinnedAt) don't sort to the top on Postgres.
    orderBy: [
      { pinnedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ],
    take: Math.min(Math.max(limit, 1), 60),
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
      },
      likes: { where: { userId: requesterId }, select: { id: true } },
      reposts: { where: { userId: requesterId }, select: { id: true } },
      bookmarks: { where: { userId: requesterId }, select: { id: true } },
    },
  });

  return {
    reels: rows.map(serializeReel),
    nextCursor: null,
  };
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
        bookmarks: { where: { userId: requesterId }, select: { id: true } },
      },
    });
    const result = {
      reels: mine.map(serializeReel),
      nextCursor: null,
    };
    if (!cursor) await cache.set(cacheKey, result, REEL_FEED_CACHE_TTL_SEC);
    return result;
  }

  // No recency window: while reel volume is low we surface ALL reels (newest
  // first, capped at the candidate pool) so the feed is never empty just
  // because nothing was posted recently. The recency score below still ranks
  // fresher clips higher. Re-introduce a `createdAt` window here once there's
  // enough volume to warrant it.
  const candidates = await prisma.reel.findMany({
    where: {
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
      bookmarks: {
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
    reels: ordered.map(serializeReel),
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

// ─── Bookmark / Unbookmark (save) ──────────────────────────

export async function bookmarkReel(reelId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.reelBookmark.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });
    if (existing) return;
    await tx.reelBookmark.create({ data: { reelId, userId } });
    await tx.reel.update({
      where: { id: reelId },
      data: { bookmarkCount: { increment: 1 } },
    });
  });
}

export async function unbookmarkReel(reelId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.reelBookmark.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });
    if (!existing) return;
    await tx.reelBookmark.delete({ where: { id: existing.id } });
    await tx.reel.update({
      where: { id: reelId },
      data: { bookmarkCount: { decrement: 1 } },
    });
  });
}

/// Reels the user has saved, newest save first.
export async function getSavedReels(userId: string, limit = 30) {
  const rows = await prisma.reelBookmark.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 60),
    select: {
      reel: {
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              avatarUrl: true,
              isVerified: true,
            },
          },
          ...reelStateInclude(userId),
        },
      },
    },
  });
  return { reels: rows.map((b) => serializeReel(b.reel)), nextCursor: null };
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

  // createMany with skipDuplicates never throws on the (reelId, userId) unique
  // constraint — its count tells us whether this was the first view (1) or a
  // repeat (0). This replaces the previous create/try-catch, which threw a
  // P2002 on every repeat/concurrent view and logged it as a Prisma ERROR
  // even though it was expected and handled.
  const { count } = await prisma.reelView.createMany({
    data: [{ reelId, userId, watchedSec, completed }],
    skipDuplicates: true,
  });

  if (count === 1) {
    // First view per user: increment the public viewCount.
    await prisma.reel.update({
      where: { id: reelId },
      data: { viewCount: { increment: 1 } },
    });
    return;
  }

  // Repeat view: keep best-known watch progress (max watchedSec, sticky
  // completed) so partial → full watch is captured but never regressed.
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

const commentUserSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
  isVerified: true,
} as const;

/// One shape for a comment sent to the client. `likes` is the per-viewer
/// include (filtered to the requester); absent → isLiked false.
function serializeComment(c: any) {
  return {
    id: c.id,
    content: c.content,
    createdAt: c.createdAt,
    parentId: c.parentId ?? null,
    likeCount: c.likeCount ?? 0,
    replyCount: c.replyCount ?? 0,
    isLiked: (c.likes?.length ?? 0) > 0,
    user: c.user,
  };
}

// Match @handles in comment text. displayName is the app's unique handle.
const MENTION_RE = /@([a-zA-Z0-9_.]{2,40})/g;

/// Notify users @mentioned in a reel comment (in-app + push). Fire-and-forget —
/// never blocks posting the comment. Because a reply prefills @author, this also
/// covers "someone replied to your comment".
async function notifyReelCommentMentions(
  reelId: string,
  commentId: string,
  authorId: string,
  content: string,
): Promise<void> {
  const handles = [
    ...new Set([...content.matchAll(MENTION_RE)].map((m) => m[1])),
  ];
  if (handles.length === 0) return;

  const users = await prisma.user.findMany({
    where: { displayName: { in: handles } },
    select: { id: true },
  });
  const targets = users.map((u) => u.id).filter((id) => id !== authorId);
  if (targets.length === 0) return;

  const author = await prisma.user.findUnique({
    where: { id: authorId },
    select: { displayName: true, avatarUrl: true },
  });
  const authorName = author?.displayName ?? 'Someone';
  const authorAvatar = author?.avatarUrl ?? undefined;
  const snippet =
    content.length > 80 ? `${content.slice(0, 77)}…` : content;
  const title = `${authorName} mentioned you`;

  for (const uid of targets) {
    createNotification({
      userId: uid,
      type: 'REEL_COMMENT_MENTION',
      title,
      body: snippet,
      imageUrl: authorAvatar,
      data: { reelId, commentId, authorId },
    }).catch(() => {});
    sendPushToUser(uid, {
      title,
      body: snippet,
      imageUrl: authorAvatar,
      data: { type: 'REEL_COMMENT_MENTION', reelId, commentId },
    }).catch(() => {});
  }
}

export async function addReelComment(
  reelId: string,
  userId: string,
  content: string,
  parentId?: string | null,
) {
  const trimmed = content.trim();
  if (!trimmed) throw new BadRequestError('Comment is required');
  if (trimmed.length > 500) throw new BadRequestError('Comment too long');

  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { id: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');

  // Replies are one level deep: a reply to a reply is re-parented to the
  // top-level comment of the thread (Instagram/FB style).
  let resolvedParentId: string | null = null;
  if (parentId) {
    const parent = await prisma.reelComment.findUnique({
      where: { id: parentId },
      select: { id: true, reelId: true, parentId: true },
    });
    if (!parent || parent.reelId !== reelId) {
      throw new NotFoundError('Parent comment not found');
    }
    resolvedParentId = parent.parentId ?? parent.id;
  }

  const comment = await prisma.$transaction(async (tx) => {
    const c = await tx.reelComment.create({
      data: { reelId, userId, content: trimmed, parentId: resolvedParentId },
      include: { user: { select: commentUserSelect } },
    });
    await tx.reel.update({
      where: { id: reelId },
      data: { commentCount: { increment: 1 } },
    });
    if (resolvedParentId) {
      await tx.reelComment.update({
        where: { id: resolvedParentId },
        data: { replyCount: { increment: 1 } },
      });
    }
    return c;
  });
  // Notify @mentioned users (fire-and-forget — never blocks the response).
  notifyReelCommentMentions(reelId, comment.id, userId, trimmed).catch(() => {});
  return serializeComment(comment);
}

export async function getReelComments(
  reelId: string,
  userId: string,
  cursor?: string,
  limit = 30,
) {
  const comments = await prisma.reelComment.findMany({
    where: { reelId, parentId: null }, // top-level only
    include: {
      user: { select: commentUserSelect },
      likes: { where: { userId }, select: { id: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = comments.length > limit;
  const items = hasMore ? comments.slice(0, limit) : comments;
  return {
    comments: items.map(serializeComment),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

export async function getReelCommentReplies(
  commentId: string,
  userId: string,
  cursor?: string,
  limit = 30,
) {
  const replies = await prisma.reelComment.findMany({
    where: { parentId: commentId },
    include: {
      user: { select: commentUserSelect },
      likes: { where: { userId }, select: { id: true } },
    },
    orderBy: { createdAt: 'asc' }, // replies read oldest-first (FB style)
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = replies.length > limit;
  const items = hasMore ? replies.slice(0, limit) : replies;
  return {
    comments: items.map(serializeComment),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

export async function likeReelComment(commentId: string, userId: string) {
  const c = await prisma.reelComment.findUnique({
    where: { id: commentId },
    select: { id: true },
  });
  if (!c) throw new NotFoundError('Comment not found');
  try {
    await prisma.$transaction(async (tx) => {
      await tx.reelCommentLike.create({ data: { commentId, userId } });
      await tx.reelComment.update({
        where: { id: commentId },
        data: { likeCount: { increment: 1 } },
      });
    });
  } catch {
    // Unique violation = already liked; idempotent no-op.
  }
}

export async function unlikeReelComment(commentId: string, userId: string) {
  const existing = await prisma.reelCommentLike.findUnique({
    where: { commentId_userId: { commentId, userId } },
  });
  if (!existing) return;
  await prisma.$transaction(async (tx) => {
    await tx.reelCommentLike.delete({
      where: { commentId_userId: { commentId, userId } },
    });
    await tx.reelComment.update({
      where: { id: commentId },
      data: { likeCount: { decrement: 1 } },
    });
  });
}

export async function deleteReelComment(commentId: string, userId: string) {
  const c = await prisma.reelComment.findUnique({
    where: { id: commentId },
    select: { userId: true, reelId: true, parentId: true, replyCount: true },
  });
  if (!c) throw new NotFoundError('Comment not found');
  if (c.userId !== userId) throw new ForbiddenError('Not your comment');

  await prisma.$transaction(async (tx) => {
    // Deleting a top-level comment cascades its replies (FK onDelete), so the
    // reel's total drops by the comment + its replies. A reply drops just 1 and
    // decrements its parent's replyCount.
    const removed = 1 + (c.parentId ? 0 : c.replyCount);
    await tx.reelComment.delete({ where: { id: commentId } });
    await tx.reel.update({
      where: { id: c.reelId },
      data: { commentCount: { decrement: removed } },
    });
    if (c.parentId) {
      await tx.reelComment.update({
        where: { id: c.parentId },
        data: { replyCount: { decrement: 1 } },
      });
    }
  });
}

// ─── Single reel ───────────────────────────────────────────

/// Fetch one reel by id (public — used by shared links / the web page and the
/// in-app deep-link viewer). Non-personalized: the per-viewer is* flags default
/// to false. Throws NotFound if missing.
export async function getReelById(reelId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
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
  if (!reel) throw new NotFoundError('Reel not found');
  return serializeReel(reel);
}

// ─── Update ────────────────────────────────────────────────

/// Edit an existing reel's caption. Ownership-checked (403 if not the author).
/// Returns the reel serialized for [userId] (the owner).
export async function updateReel(
  reelId: string,
  userId: string,
  data: { caption?: string | null }
) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { userId: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');
  if (reel.userId !== userId) throw new ForbiddenError('Not your reel');

  const updateData: { caption?: string | null } = {};
  if (data.caption !== undefined) {
    const trimmed = (data.caption ?? '').trim();
    // Cap defensively (Instagram-style limit); the client also enforces this.
    updateData.caption = trimmed.length ? trimmed.slice(0, 2200) : null;
  }

  const updated = await prisma.reel.update({
    where: { id: reelId },
    data: updateData,
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
      ...reelStateInclude(userId),
    },
  });
  await invalidateReelFeedCache(userId).catch(() => {});
  return serializeReel(updated);
}

// ─── Pin ───────────────────────────────────────────────────

const MAX_PINNED_REELS = 3;

/// Pin a reel to the top of the author's profile. Ownership-checked. Capped at
/// [MAX_PINNED_REELS] pins per user (BadRequest when exceeded). Idempotent — a
/// reel that's already pinned keeps its original pin time.
export async function pinReel(reelId: string, userId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { userId: true, pinnedAt: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');
  if (reel.userId !== userId) throw new ForbiddenError('Not your reel');
  if (reel.pinnedAt) return; // already pinned — no-op

  const pinnedCount = await prisma.reel.count({
    where: { userId, pinnedAt: { not: null } },
  });
  if (pinnedCount >= MAX_PINNED_REELS) {
    throw new BadRequestError(
      `You can pin up to ${MAX_PINNED_REELS} reels`,
    );
  }

  await prisma.reel.update({
    where: { id: reelId },
    data: { pinnedAt: new Date() },
  });
  await invalidateReelFeedCache(userId).catch(() => {});
}

/// Unpin a reel. Ownership-checked. Idempotent.
export async function unpinReel(reelId: string, userId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { userId: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');
  if (reel.userId !== userId) throw new ForbiddenError('Not your reel');

  await prisma.reel.update({
    where: { id: reelId },
    data: { pinnedAt: null },
  });
  await invalidateReelFeedCache(userId).catch(() => {});
}

// ─── Delete ────────────────────────────────────────────────

export async function deleteReel(reelId: string, userId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { userId: true, cloudinaryId: true, hlsKey: true },
  });
  if (!reel) throw new NotFoundError('Reel not found');
  if (reel.userId !== userId) throw new ForbiddenError('Not your reel');

  await prisma.reel.delete({ where: { id: reelId } });
  // Clean up both the MP4 object and (if present) the whole HLS prefix.
  if (reel.cloudinaryId) {
    deleteFromR2(reel.cloudinaryId).catch((err) => {
      logger.warn({ err, key: reel.cloudinaryId }, 'Failed to delete reel MP4 from R2');
    });
  }
  if (reel.hlsKey) {
    deleteR2Prefix(reel.hlsKey).catch((err) => {
      logger.warn({ err, key: reel.hlsKey }, 'Failed to delete reel HLS from R2');
    });
  }
  await invalidateReelFeedCache(userId).catch(() => {});
}
