import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError } from '../../shared/errors';
import { getBlockedUserIds } from '../spotlight/spotlight.service';
import { isPro } from '../../shared/usage.service';
import { fileToStoryImageUrl, fileToStoryVideoUrl, ensureBuffer } from '../../shared/upload';
import * as cloudinaryService from '../../shared/cloudinary.service';
import { deleteFromR2 } from '../../shared/r2.service';
import { moderateImageBuffer, moderateVideoBuffer } from '../../shared/moderation.service';
import { checkCaptionLinks } from '../../shared/urlSafety';
import { getOrCreateDirectConversation, sendMessage } from '../chat/chat.service';
import { notifyFollowersOfNewStory, notifyStoryOwnerOfView, checkStoryMilestone } from './story.notify';
import { markStoryNotificationsAsRead, markStoryLikeNotificationsAsRead } from '../notification/notification.service';
import * as cache from '../../shared/redis.service';
import { getIO } from '../../config/socket';

/**
 * Delete a story slide's underlying media from whichever storage backend
 * actually holds it. The `cloudinaryId` column predates the R2 migration
 * and now stores either:
 *   - a Cloudinary publicId (legacy slides), prefixed `yomeet/`
 *   - an R2 object key (new slides), prefixed `stories/`
 * The prefix is the discriminator. Fire-and-forget, like the calls it
 * replaced — failures shouldn't block the user-facing delete.
 */
function deleteSlideMedia(cloudinaryId: string, type: 'IMAGE' | 'VIDEO' | 'TEXT'): Promise<unknown> {
  if (cloudinaryId.startsWith('stories/')) {
    return deleteFromR2(cloudinaryId);
  }
  const resourceType = type === 'VIDEO' ? 'video' : 'image';
  return cloudinaryService.deleteFile(cloudinaryId, resourceType);
}

// Must stay in sync with the app's story/reel reaction picker
// (_kStoryReactionEmojis + _kMoreReactionEmojis in story_viewer_screen.dart) —
// any emoji the picker (or the 👍 like button) can send must be accepted here,
// or reactToStory 400s and the reaction silently fails to persist (e.g. the 👍
// like not sticking, so the filled-thumb state vanished on re-view).
export const ALLOWED_REACTION_EMOJIS = [
  '❤️', '👍', '😂', '😮', '😢', '🙏',
  '🔥', '👏', '💯', '😍', '🤯', '🥰', '🥳', '😎', '💀', '🙌',
] as const;
const ALLOWED_REACTION_SET = new Set<string>(ALLOWED_REACTION_EMOJIS);

// ─── Feed Cache ─────────────────────────────────────────────
// Per-user feed cache with short TTL to avoid hammering the DB on every poll.

interface CachedFeed {
  data: any[];
  expiresAt: number;
}

const feedCache = new Map<string, CachedFeed>();
const FEED_CACHE_TTL_MS = 60_000; // 60 seconds

// Redis-backed caches for the Following / Discover tabs (the main feed above
// uses the in-memory feedCache). Same 60s window, but shared across instances.
const FEED_CACHE_TTL_SEC = 60;
const followingFeedKey = (uid: string) => `stories:following:${uid}`;
const discoverFeedKey = (uid: string) => `stories:discover:${uid}`;

/** Invalidate all feed caches (call after story create/delete/boost). */
export function invalidateFeedCache(userId?: string) {
  if (userId) {
    feedCache.delete(userId);
    // Mirror onto the Redis-backed following/discover feeds. Fire-and-forget:
    // cache.del already swallows errors and no-ops when Redis is unconfigured.
    void cache.del(followingFeedKey(userId));
    void cache.del(discoverFeedKey(userId));
  } else {
    feedCache.clear();
    void cache.delPattern(followingFeedKey('*'));
    void cache.delPattern(discoverFeedKey('*'));
  }
}

// ─── Types ──────────────────────────────────────────────────

interface SlideMetadata {
  type: 'IMAGE' | 'VIDEO' | 'TEXT';
  position: number;
  duration?: number;
  caption?: string;
  // Loose JSON blobs — validated at use site rather than at the boundary
  // so the router can hand JSON.parse output through without tight typing.
  music?: Record<string, unknown>;
  videoEdits?: Record<string, unknown>;
  // Native text-story payload (text + gradient + font + formatting) so the
  // viewer renders the body as live, tappable text.
  textStory?: Record<string, unknown>;
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
    thumbnailFiles?: Express.Multer.File[];
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

  // ── Link safety (caption + text-story body URLs) ────────────
  // Clickable story links are URLs typed into a caption OR into a text story's
  // body; block adult/dangerous ones before anything is uploaded so they never
  // reach viewers.
  if (slidesMetadata) {
    for (const meta of slidesMetadata) {
      const bodyText = (meta?.textStory as { text?: string } | undefined)?.text;
      for (const source of [meta?.caption, bodyText]) {
        const verdict = checkCaptionLinks(source);
        if (!verdict.safe) {
          const err: any = new BadRequestError(verdict.reason || 'This link isn’t allowed.');
          err.code = 'UNSAFE_LINK';
          throw err;
        }
      }
    }
  }

  // ── Content moderation (pre-creation) ───────────────────────
  // EVERY slide — image AND video — is checked BEFORE the story is created, so
  // nothing unsafe is ever visible to anyone. Video used to be checked in the
  // BACKGROUND (the story posted, showed to others, then vanished if unsafe);
  // gpt-4o-mini frame-sampling is fast enough (~2-3s) to do it up-front now,
  // like reels, so a bad clip is rejected before the story exists.
  for (let i = 0; i < files.length; i++) {
    const isVideo = (slidesMetadata?.[i]?.type ?? 'IMAGE') === 'VIDEO';
    // Large story videos land on disk (multer diskStorage) to avoid OOM, so
    // read each file's bytes just-in-time. The buffer is a per-iteration local
    // and the loop is sequential, so at most one slide is in memory here.
    const buf = await ensureBuffer(files[i]);
    const verdict = isVideo
      ? await moderateVideoBuffer(
          buf,
          files[i].originalname?.match(/\.[a-z0-9]{2,5}$/i)?.[0] || '.mp4',
        )
      : await moderateImageBuffer(buf, files[i].originalname);
    // Videos additionally let an `unavailable` verdict through (a codec we
    // couldn't decode / API hiccup) rather than falsely rejecting a legit clip;
    // images fail closed.
    const block = isVideo ? !verdict.safe && !verdict.unavailable : !verdict.safe;
    if (block) {
      const err: any = new BadRequestError(verdict.reason || 'Content failed moderation');
      err.code = 'MODERATION_REJECTED';
      throw err;
    }
  }

  // Upload slides SEQUENTIALLY (not Promise.all): with large videos on disk,
  // parallel transcode+upload would load every slide's buffer into memory at
  // once and OOM the instance. One slide at a time keeps peak RAM ~one video.
  let videoCount = 0;
  const uploads: Prisma.StorySlideCreateWithoutStoryInput[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const meta = slidesMetadata?.[index];
    const slideType = meta?.type ?? 'IMAGE';
    const position = meta?.position ?? index;

    // Prisma JSON fields require `undefined` for "no value" (not null).
    // Pack music + videoEdits into the same JSON blob so the slide row
    // round-trips both for the viewer.
    const metaBlob: Record<string, any> = {};
    if (meta?.music) metaBlob.music = meta.music;
    if (meta?.videoEdits) metaBlob.videoEdits = meta.videoEdits;
    if (meta?.textStory) metaBlob.textStory = meta.textStory;
    const slideMetadata: Record<string, any> | undefined =
        Object.keys(metaBlob).length > 0 ? metaBlob : undefined;
    if (slideType === 'VIDEO') {
      const result = await fileToStoryVideoUrl(file, userId);
      // Use client-provided thumbnail when R2 can't generate one server-side.
      // thumbnailFiles is indexed by video order (not slide order), so use
      // a dedicated counter rather than the overall slide index.
      let thumbnailUrl = result.thumbnailUrl || null;
      const thumbFile = options?.thumbnailFiles?.[videoCount];
      videoCount++;
      if (!thumbnailUrl && thumbFile) {
        const thumbResult = await fileToStoryImageUrl(thumbFile, userId);
        thumbnailUrl = thumbResult.secureUrl;
      }
      uploads.push({
        type: 'VIDEO' as const,
        mediaUrl: result.secureUrl,
        cloudinaryId: result.publicId,
        thumbnailUrl,
        caption: meta?.caption ?? null,
        duration: meta?.duration ?? null,
        position,
        metadata: slideMetadata ?? undefined,
      });
    } else {
      // IMAGE or TEXT — both use image upload
      const result = await fileToStoryImageUrl(file, userId);
      uploads.push({
        type: slideType as 'IMAGE' | 'TEXT',
        mediaUrl: result.secureUrl,
        cloudinaryId: result.publicId,
        thumbnailUrl: null,
        caption: meta?.caption ?? null,
        duration: meta?.duration ?? null,
        position,
        metadata: slideMetadata ?? undefined,
      });
    }
  }

  // NOTE: images are moderated BEFORE upload (above). Videos are moderated in
  // the BACKGROUND after the story is created (see below) — Sightengine's
  // synchronous video analysis is slow/unbounded and blocking the upload here
  // caused legit video posts to time out and fail. The story is auto-removed
  // if a video turns out unsafe.

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
  const [blockedIds, followerIds, mutedIds, hiddenFromIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getFollowerIds(requesterId),
    getMutedUserIds(requesterId),
    getHiddenFromOwnerIds(requesterId),
  ]);

  const mutedSet = new Set(mutedIds);
  const hiddenFromSet = new Set(hiddenFromIds);
  const audienceIds = [requesterId, ...followerIds].filter(
    (id) => !blockedIds.has(id) && !mutedSet.has(id) && !hiddenFromSet.has(id),
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
          // Music + videoEdits ride along in this JSON blob. Without
          // it, the viewer never gets the music URL/title and the
          // attached track silently doesn't play.
          metadata: true,
          // Per-slide views: requester's own view row (drives `viewed`)
          // plus the total view count for this individual slide.
          views: {
            where: { viewerId: requesterId },
            select: { id: true },
          },
          _count: { select: { views: true } },
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
      slides: s.slides.map(toFeedSlide),
      viewed: s.views.length > 0,
      myReaction: s.reactions[0]?.emoji ?? null,
      viewCount: s._count.views,
      likeCount: s.likeCount,
      commentCount: s.commentCount,
      repostCount: s.repostCount,
      shareCount: s.shareCount,
      downloadCount: s.downloadCount,
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

/// Returns a single user's active stories in the same shape as one feed
/// entry, so the client can open the story viewer for an arbitrary user
/// (e.g. tapping a viewer's avatar in the viewers sheet). Null when the user
/// has no active stories or is blocked either way.
export async function getUserStories(userId: string, requesterId: string) {
  const blockedIds = await getBlockedUserIds(requesterId);
  if (blockedIds.has(userId)) return null;

  const now = new Date();
  const stories = await prisma.story.findMany({
    where: {
      userId,
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
          metadata: true,
          views: { where: { viewerId: requesterId }, select: { id: true } },
          _count: { select: { views: true } },
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
      views: { where: { viewerId: requesterId }, select: { id: true } },
      reactions: { where: { userId: requesterId }, select: { emoji: true } },
      _count: { select: { views: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (stories.length === 0) return null;

  const u = stories[0].user;
  return {
    userId,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    isVerified: u.isVerified,
    isOfficial: u.verifiedRole === 'official',
    isSelf: userId === requesterId,
    hasUnviewed: stories.some(
      (s) => s.views.length === 0 && userId !== requesterId,
    ),
    stories: stories.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      slides: s.slides.map(toFeedSlide),
      viewed: s.views.length > 0,
      myReaction: s.reactions[0]?.emoji ?? null,
      viewCount: s._count.views,
      likeCount: s.likeCount,
      commentCount: s.commentCount,
      repostCount: s.repostCount,
      shareCount: s.shareCount,
      downloadCount: s.downloadCount,
    })),
  };
}

// Maps a slide row (with the per-slide views/_count include) to the feed
// payload shape. Shared by getStoryFeed and groupStoriesByUser so the slide
// fields — including the Instagram-style per-slide viewCount/viewed — stay
// defined in one place.
function toFeedSlide(slide: any) {
  return {
    id: slide.id,
    type: slide.type,
    mediaUrl: slide.mediaUrl,
    thumbnailUrl: slide.thumbnailUrl,
    caption: slide.caption,
    duration: slide.duration,
    position: slide.position,
    // Pass through the music + videoEdits JSON the viewer needs.
    metadata: slide.metadata,
    // Per-slide engagement (Instagram-style).
    viewCount: slide._count.views,
    viewed: slide.views.length > 0,
  };
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
      slides: s.slides.map(toFeedSlide),
      viewed: s.views.length > 0,
      myReaction: s.reactions[0]?.emoji ?? null,
      viewCount: s._count.views,
      likeCount: s.likeCount,
      commentCount: s.commentCount,
      repostCount: s.repostCount,
      shareCount: s.shareCount,
      downloadCount: s.downloadCount,
    })),
  }));
}

// ─── Get Following Feed ─────────────────────────────────────
// Stories of users I FOLLOW (regardless of whether they follow me back).

export async function getFollowingFeed(requesterId: string) {
  const key = followingFeedKey(requesterId);
  const cached = await cache.get<any[]>(key, true);
  if (cached) return cached;
  const data = await computeFollowingFeed(requesterId);
  await cache.set(key, data, FEED_CACHE_TTL_SEC);
  return data;
}

async function computeFollowingFeed(requesterId: string) {
  const [blockedIds, followingIds, mutedIds, hiddenFromIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getFollowingIds(requesterId),
    getMutedUserIds(requesterId),
    getHiddenFromOwnerIds(requesterId),
  ]);

  const mutedSet = new Set(mutedIds);
  const hiddenFromSet = new Set(hiddenFromIds);
  const audienceIds = followingIds.filter(
    (id) => !blockedIds.has(id) && !mutedSet.has(id) && !hiddenFromSet.has(id),
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
          // Music + videoEdits ride along in this JSON blob. Without
          // it, the viewer never gets the music URL/title and the
          // attached track silently doesn't play.
          metadata: true,
          // Per-slide views: requester's own view row (drives `viewed`)
          // plus the total view count for this individual slide.
          views: {
            where: { viewerId: requesterId },
            select: { id: true },
          },
          _count: { select: { views: true } },
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
  const key = discoverFeedKey(requesterId);
  const cached = await cache.get<any[]>(key, true);
  if (cached) return cached;
  const data = await computeDiscoverFeed(requesterId);
  await cache.set(key, data, FEED_CACHE_TTL_SEC);
  return data;
}

async function computeDiscoverFeed(requesterId: string) {
  const [blockedIds, followingIds, followerIds, mutedIds, hiddenFromIds] = await Promise.all([
    getBlockedUserIds(requesterId),
    getFollowingIds(requesterId),
    getFollowerIds(requesterId),
    getMutedUserIds(requesterId),
    getHiddenFromOwnerIds(requesterId),
  ]);

  const excludeIds = new Set<string>([
    requesterId,
    ...followingIds,
    ...followerIds,
    ...mutedIds,
    ...hiddenFromIds,
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
          // Music + videoEdits ride along in this JSON blob. Without
          // it, the viewer never gets the music URL/title and the
          // attached track silently doesn't play.
          metadata: true,
          // Per-slide views: requester's own view row (drives `viewed`)
          // plus the total view count for this individual slide.
          views: {
            where: { viewerId: requesterId },
            select: { id: true },
          },
          _count: { select: { views: true } },
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

// Owners who have hidden their stories FROM me — their stories are
// excluded from my feeds. (Inverse of muting.)
async function getHiddenFromOwnerIds(viewerId: string): Promise<string[]> {
  const rows = await prisma.storyHide.findMany({
    where: { hiddenUserId: viewerId },
    select: { ownerId: true },
  });
  return rows.map((r) => r.ownerId);
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

// ─── Hide / Unhide my story from a viewer ───────────────────
// ownerId hides their own stories from hiddenUserId. Invalidate the
// VIEWER's cache (not the owner's) since it's the viewer's feed that
// changes.

export async function hideStoryFromViewer(ownerId: string, hiddenUserId: string) {
  if (ownerId === hiddenUserId) {
    throw new BadRequestError('Cannot hide your story from yourself');
  }
  await prisma.storyHide.upsert({
    where: { ownerId_hiddenUserId: { ownerId, hiddenUserId } },
    create: { ownerId, hiddenUserId },
    update: {},
  });
  invalidateFeedCache(hiddenUserId);
}

export async function unhideStoryFromViewer(ownerId: string, hiddenUserId: string) {
  await prisma.storyHide.deleteMany({
    where: { ownerId, hiddenUserId },
  });
  invalidateFeedCache(hiddenUserId);
}

// Users the owner has hidden their stories from (for a management list).
export async function getHiddenViewers(ownerId: string) {
  const rows = await prisma.storyHide.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    select: {
      hiddenUser: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
    },
  });
  return rows.map((r) => ({
    userId: r.hiddenUser.id,
    displayName: r.hiddenUser.displayName,
    avatarUrl: r.hiddenUser.avatarUrl,
    isVerified: r.hiddenUser.isVerified,
  }));
}

// ─── Mark Story Viewed ──────────────────────────────────────

export async function markStoryViewed(storyId: string, viewerId: string, isStealth = false) {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { userId: true },
  });
  if (!story) return;
  // The owner viewing their own story is not a view — don't record it (so it
  // never shows in the count/viewer list) and don't self-notify.
  if (story.userId === viewerId) return;

  // The viewer has now seen this story, so clear any "posted a new story"
  // alert it raised in their bell — whether they got here from the push or
  // just by browsing the feed. Fire-and-forget, idempotent, and independent
  // of whether this is a fresh or repeat view (a repeat view should still
  // settle a notification that somehow lingered).
  void markStoryNotificationsAsRead(viewerId, storyId).catch((err) => {
    logger.warn({ err, storyId, viewerId }, 'Failed to clear story notification on view');
  });

  const result = await prisma.storyView.createMany({
    data: [{ storyId, viewerId, isStealth }],
    skipDuplicates: true,
  });
  // Fire the "viewed your story" notification on the FIRST view by this viewer
  // (createMany.count > 0 means a row was actually inserted). Every viewer
  // counts and is visible — there is no invisible/stealth viewing.
  if (result.count > 0) {
    // Fire-and-forget — don't await, don't block playback on push.
    void notifyStoryOwnerOfView(storyId, story.userId, viewerId);
    // Milestone check: notify the owner if they just crossed a view tier.
    const viewCount = await prisma.storyView.count({
      where: { storyId },
    });
    void checkStoryMilestone(storyId, story.userId, 'views', viewCount);
  }
}

// ─── Mark Story Slide Viewed (per-slide, Instagram-style) ───

export async function markStorySlideViewed(slideId: string, viewerId: string, isStealth = false) {
  // Resolve the slide → its parent story (needed to keep the story-level
  // StoryView in sync for the unviewed ring / notification / milestones).
  const slide = await prisma.storySlide.findUnique({
    where: { id: slideId },
    select: { storyId: true, story: { select: { userId: true } } },
  });
  if (!slide) return;
  // Owner viewing their own slide isn't a view — skip recording entirely.
  if (slide.story.userId === viewerId) return;

  // Record the per-slide view (idempotent on [slideId, viewerId]).
  const inserted = await prisma.storySlideView.createMany({
    data: [{ slideId, viewerId, isStealth }],
    skipDuplicates: true,
  });

  // Keep the story-level view in sync so existing behaviour (ring,
  // "viewed your story" push, milestone tiers) is unchanged. markStoryViewed
  // is itself idempotent and only fires the notification on the first insert.
  await markStoryViewed(slide.storyId, viewerId, isStealth);

  // Real-time: push the updated slide view count to the story owner so their
  // open viewer / count updates without a manual refresh. Only on a genuinely
  // new view. Best-effort (socket may be uninitialised).
  if (inserted.count > 0) {
    try {
      const viewCount = await prisma.storySlideView.count({
        where: { slideId },
      });
      getIO()
        .to(`user:${slide.story.userId}`)
        .emit('story:view', { storyId: slide.storyId, slideId, viewCount });
    } catch {
      // Socket not initialised (e.g. tests) — ignore.
    }
  }
}

// ─── Viewers list shaping (shared by story- and slide-level) ─

/// Enriches a list of raw view rows for the viewers sheet: resolves each
/// viewer's profile, whether they have an active story (avatar ring), and
/// whether they follow the owner ("My Followers" filter). Used by both
/// getStoryViewers (story-level) and getStorySlideViewers (per-slide).
async function enrichViewerRows(
  views: Array<{
    viewerId: string;
    createdAt: Date;
    liked: boolean;
    reaction: string | null;
  }>,
  ownerId: string,
) {
  const viewerIds = views.map((v) => v.viewerId);
  const now = new Date();
  const [users, viewerSlides, followerRows] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: viewerIds } },
      select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
    }),
    // Each viewer's active slides, with the owner's own view row attached so
    // we can count how many of that viewer's slides the owner has seen. This
    // powers the segmented story ring (green = unseen, grey = seen).
    prisma.storySlide.findMany({
      where: {
        story: {
          userId: { in: viewerIds },
          OR: [{ expiresAt: { gt: now } }, { isPermanent: true }],
        },
      },
      select: {
        story: { select: { userId: true } },
        views: { where: { viewerId: ownerId }, select: { id: true } },
      },
    }),
    prisma.follow.findMany({
      where: { followingId: ownerId, followerId: { in: viewerIds } },
      select: { followerId: true },
    }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const followerSet = new Set(followerRows.map((r) => r.followerId));

  // Per-viewer totals: how many active slides they have, and how many the
  // owner has already viewed.
  const storyCountMap = new Map<string, number>();
  const viewedCountMap = new Map<string, number>();
  for (const slide of viewerSlides) {
    const uid = slide.story.userId;
    storyCountMap.set(uid, (storyCountMap.get(uid) ?? 0) + 1);
    if (slide.views.length > 0) {
      viewedCountMap.set(uid, (viewedCountMap.get(uid) ?? 0) + 1);
    }
  }

  return views.map((v) => {
    const user = userMap.get(v.viewerId);
    const storyCount = storyCountMap.get(v.viewerId) ?? 0;
    return {
      userId: v.viewerId,
      viewedAt: v.createdAt,
      liked: v.liked,
      reaction: v.reaction,
      displayName: user?.displayName ?? 'Unknown',
      avatarUrl: user?.avatarUrl ?? null,
      isVerified: user?.isVerified ?? false,
      hasActiveStory: storyCount > 0,
      storyCount,
      viewedCount: viewedCountMap.get(v.viewerId) ?? 0,
      isFollower: followerSet.has(v.viewerId),
    };
  });
}

// ─── Get Story Slide Viewers (per-slide) ────────────────────

export async function getStorySlideViewers(slideId: string, userId: string) {
  // Owner check via the slide's parent story.
  const slide = await prisma.storySlide.findUnique({
    where: { id: slideId },
    select: { story: { select: { id: true, userId: true } } },
  });
  if (!slide || slide.story.userId !== userId) {
    return null;
  }

  // The owner is looking at exactly who liked/reacted to this story, so clear
  // the STORY_LIKED alerts from their bell. Fire-and-forget + idempotent.
  void markStoryLikeNotificationsAsRead(userId, slide.story.id).catch((err) => {
    logger.warn({ err, storyId: slide.story.id, userId }, 'Failed to clear story-like notifications on viewers open');
  });

  const views = await prisma.storySlideView.findMany({
    where: { slideId },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Reactions live in StoryReaction (story-level; one emoji per viewer — the
  // same row likeStory/reactToStory write). Resolve each viewer's emoji so the
  // viewers sheet can show the exact reaction, not just the ❤️ like.
  const viewerIds = views.map((v) => v.viewerId);
  const reactionRows = viewerIds.length
    ? await prisma.storyReaction.findMany({
        where: { storyId: slide.story.id, userId: { in: viewerIds } },
        select: { userId: true, emoji: true },
      })
    : [];
  const reactionMap = new Map(reactionRows.map((r) => [r.userId, r.emoji]));

  return enrichViewerRows(
    views.map((v) => ({
      viewerId: v.viewerId,
      createdAt: v.createdAt,
      reaction: reactionMap.get(v.viewerId) ?? null,
      liked: reactionMap.get(v.viewerId) === '❤️',
    })),
    userId,
  );
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

  // Owner is viewing who liked/reacted — clear the STORY_LIKED bell alerts.
  void markStoryLikeNotificationsAsRead(userId, storyId).catch((err) => {
    logger.warn({ err, storyId, userId }, 'Failed to clear story-like notifications on viewers open');
  });

  const views = await prisma.storyView.findMany({
    where: { storyId },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Resolve each viewer's reaction emoji from StoryReaction (source of truth).
  const viewerIds = views.map((v) => v.viewerId);
  const reactionRows = viewerIds.length
    ? await prisma.storyReaction.findMany({
        where: { storyId, userId: { in: viewerIds } },
        select: { userId: true, emoji: true },
      })
    : [];
  const reactionMap = new Map(reactionRows.map((r) => [r.userId, r.emoji]));

  return enrichViewerRows(
    views.map((v) => ({
      viewerId: v.viewerId,
      createdAt: v.createdAt,
      reaction: reactionMap.get(v.viewerId) ?? null,
      liked: reactionMap.get(v.viewerId) === '❤️',
    })),
    userId,
  );
}

// ─── Like Story (legacy endpoint, kept for old app builds) ─────

export async function likeStory(storyId: string, viewerId: string, liked: boolean = true) {
  // Snapshot previous like state from the source-of-truth StoryReaction
  // table — that's what reactToStory + clearStoryReaction use, and the
  // legacy StoryView.liked can drift after an emoji-react flow.
  const existing = await prisma.storyReaction.findUnique({
    where: { storyId_userId: { storyId, userId: viewerId } },
    select: { emoji: true },
  });
  const wasLiked = existing?.emoji === '❤️';

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

  // Keep the denormalized counter in sync with the actual transition.
  // Skip the write when nothing changed so concurrent identical taps
  // don't double-count.
  if (wasLiked !== liked) {
    await prisma.story.update({
      where: { id: storyId },
      data: { likeCount: { increment: liked ? 1 : -1 } },
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

  // Capture the previous reaction so we can keep likeCount in sync as
  // the user flips between ❤️ and other emojis.
  const previous = await prisma.storyReaction.findUnique({
    where: { storyId_userId: { storyId, userId } },
    select: { emoji: true },
  });
  const wasLiked = previous?.emoji === '❤️';
  const isLiked = emoji === '❤️';

  await prisma.storyReaction.upsert({
    where: { storyId_userId: { storyId, userId } },
    create: { storyId, userId, emoji },
    update: { emoji },
  });

  // Mirror ❤️ into legacy StoryView.liked so old app builds keep showing the like.
  await prisma.storyView.upsert({
    where: { storyId_viewerId: { storyId, viewerId: userId } },
    create: { storyId, viewerId: userId, liked: isLiked },
    update: { liked: isLiked },
  });

  if (wasLiked !== isLiked) {
    await prisma.story.update({
      where: { id: storyId },
      data: { likeCount: { increment: isLiked ? 1 : -1 } },
    });
  }

  invalidateFeedCache(userId);
  return { emoji };
}

export async function clearStoryReaction(storyId: string, userId: string) {
  // Read first so we know whether the cleared reaction was a like.
  // deleteMany returns a row count but not the rows themselves.
  const existing = await prisma.storyReaction.findUnique({
    where: { storyId_userId: { storyId, userId } },
    select: { emoji: true },
  });
  await prisma.storyReaction.deleteMany({
    where: { storyId, userId },
  });
  await prisma.storyView.updateMany({
    where: { storyId, viewerId: userId },
    data: { liked: false },
  });
  if (existing?.emoji === '❤️') {
    await prisma.story.update({
      where: { id: storyId },
      data: { likeCount: { decrement: 1 } },
    });
  }
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

  // Bump the story's public comment counter shown in the viewer rail.
  await prisma.story.update({
    where: { id: storyId },
    data: { commentCount: { increment: 1 } },
  });

  return { conversationId: conversation.id, messageId: message.id };
}

// ─── Engagement Counter Bumps (share / download / repost) ──
// Lightweight write-only endpoints fired from the viewer's right-side
// rail. They don't return data — the FE optimistically increments the
// count locally and uses a fire-and-forget HTTP call to keep the
// authoritative DB number in sync. Returning {ok: true} keeps the
// route shape simple for retries.

export async function bumpStoryShare(storyId: string): Promise<boolean> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true },
  });
  if (!story) return false;
  await prisma.story.update({
    where: { id: storyId },
    data: { shareCount: { increment: 1 } },
  });
  return true;
}

export async function bumpStoryDownload(storyId: string): Promise<boolean> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true },
  });
  if (!story) return false;
  await prisma.story.update({
    where: { id: storyId },
    data: { downloadCount: { increment: 1 } },
  });
  return true;
}

export async function bumpStoryRepost(storyId: string): Promise<boolean> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true },
  });
  if (!story) return false;
  await prisma.story.update({
    where: { id: storyId },
    data: { repostCount: { increment: 1 } },
  });
  return true;
}

// ─── Update Slide Caption ──────────────────────────────────

export async function updateSlideCaption(slideId: string, userId: string, caption: string | null) {
  const slide = await prisma.storySlide.findUnique({
    where: { id: slideId },
    include: { story: { select: { userId: true } } },
  });

  if (!slide) return { updated: false, reason: 'not_found' as const };
  if (slide.story.userId !== userId) return { updated: false, reason: 'not_owner' as const };

  // Same link-safety gate as createStory — a caption edit mustn't smuggle in a
  // porn/dangerous URL after the fact.
  const verdict = checkCaptionLinks(caption);
  if (!verdict.safe) {
    const err: any = new BadRequestError(verdict.reason || 'This link isn’t allowed.');
    err.code = 'UNSAFE_LINK';
    throw err;
  }

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

  // Cloudinary cleanup is fire-and-forget — same pattern as deleteStory.
  // Awaiting it would block the API response on a third-party round-trip
  // (and 500 on cloudinary slowness / outage), which was likely the cause
  // of the "Failed to delete" toast users were hitting.
  if (slide.cloudinaryId) {
    deleteSlideMedia(slide.cloudinaryId, slide.type as 'IMAGE' | 'VIDEO' | 'TEXT')
      .catch((err) =>
        logger.warn({ err, mediaId: slide.cloudinaryId }, 'Slide media delete failed (background)'),
      );
  }

  // If this is the last slide, delete the entire story
  if (slide.story._count.slides <= 1) {
    await prisma.story.delete({ where: { id: slide.storyId } });
    logger.info({ slideId, storyId: slide.storyId, userId }, 'Last slide deleted, story removed');
    invalidateFeedCache();
    return { deleted: true, storyDeleted: true, storyId: slide.storyId };
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
  return { deleted: true, storyDeleted: false, storyId: slide.storyId };
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

  // Clean up media assets (R2 or Cloudinary) — don't block on failures
  for (const slide of story.slides) {
    if (slide.cloudinaryId) {
      deleteSlideMedia(slide.cloudinaryId, slide.type as 'IMAGE' | 'VIDEO' | 'TEXT').catch(() => {});
    }
  }
  logger.info({ storyId, userId }, 'Story deleted');
  invalidateFeedCache(); // Deletion affects everyone's feed
  return { deleted: true };
}

// ─── Cleanup Expired Stories ────────────────────────────────

export async function cleanupExpiredStories(): Promise<number> {
  const BATCH = 200;
  // Safety valve: cap the work per run (20k stories) so a pathological state
  // can never spin forever. The next scheduled run picks up any remainder.
  const MAX_BATCHES = 100;

  let total = 0;

  // Drain ALL expired stories this run, in bounded batches — one findMany of
  // thousands would spike memory. Each deleteMany removes the rows we just
  // handled, so the next findMany returns the following batch until none remain.
  for (let i = 0; i < MAX_BATCHES; i++) {
    const now = new Date();
    const expired = await prisma.story.findMany({
      where: { expiresAt: { lte: now }, isPermanent: false },
      include: { slides: { select: { cloudinaryId: true, type: true } } },
      take: BATCH,
    });

    if (expired.length === 0) break;

    // Delete media assets (R2 or Cloudinary) — fire concurrently per story to avoid serial N+1
    await Promise.allSettled(
      expired.flatMap((story) =>
        story.slides
          .filter((slide) => slide.cloudinaryId)
          .map((slide) =>
            deleteSlideMedia(slide.cloudinaryId!, slide.type as 'IMAGE' | 'VIDEO' | 'TEXT'),
          ),
      ),
    );

    const expiredIds = expired.map((s) => s.id);
    const result = await prisma.story.deleteMany({
      where: { id: { in: expiredIds } },
    });
    total += result.count;

    // Found rows but deleted none — bail rather than re-find the same rows forever.
    if (result.count === 0) break;
    // Last batch was partial → nothing left to drain.
    if (expired.length < BATCH) break;
  }

  if (total > 0) {
    invalidateFeedCache(); // Expired stories removed, refresh all feeds
  }

  return total;
}
