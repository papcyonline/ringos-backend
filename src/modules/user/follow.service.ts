import { prisma } from '../../config/database';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';
import { invalidateFeedCache } from '../story/story.service';
import { markNewFollowerNotificationsAsRead } from '../notification/notification.service';

/**
 * Record that the user just looked at their own followers list: stamp
 * `lastFollowerCheckAt` (so the new-followers push digest only counts followers
 * gained after this moment) and clear their NEW_FOLLOWER bell notifications.
 */
export async function markFollowersSeen(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { lastFollowerCheckAt: new Date() },
  });
  await markNewFollowerNotificationsAsRead(userId);
}

export async function followUser(followerId: string, followingId: string) {
  if (followerId === followingId) {
    throw new BadRequestError('Cannot follow yourself');
  }

  const target = await prisma.user.findUnique({ where: { id: followingId } });
  if (!target) throw new NotFoundError('User not found');

  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });
  if (existing) throw new ConflictError('Already following this user');

  const result = await prisma.follow.create({
    data: { followerId, followingId },
    select: { id: true, followerId: true, followingId: true, createdAt: true },
  });
  // Story feed is keyed by who you follow; without this the follower
  // sees a stale feed for up to 60s after following someone new.
  invalidateFeedCache(followerId);
  return result;
}

export async function unfollowUser(followerId: string, followingId: string) {
  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });
  if (!existing) throw new NotFoundError('Not following this user');

  await prisma.follow.delete({
    where: { followerId_followingId: { followerId, followingId } },
  });
  invalidateFeedCache(followerId);
}

/// Resolves the viewer's relationship to a set of users: which the viewer
/// follows (isFollowedByMe) and which follow the viewer (isFollowingMe).
async function viewerRelationships(viewerId: string, userIds: string[]) {
  if (userIds.length === 0) {
    return { iFollow: new Set<string>(), followsMe: new Set<string>() };
  }
  const [iFollowRows, followsMeRows] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: userIds } },
      select: { followingId: true },
    }),
    prisma.follow.findMany({
      where: { followingId: viewerId, followerId: { in: userIds } },
      select: { followerId: true },
    }),
  ]);
  return {
    iFollow: new Set(iFollowRows.map((f) => f.followingId)),
    followsMe: new Set(followsMeRows.map((f) => f.followerId)),
  };
}

// Cap how many follow rows a single request can load. Without this, a request
// for a celebrity's followers would pull every row (+ joined user) into memory
// and could OOM the worker. Clients that pass a smaller `limit` + `cursor`
// paginate; older clients (no params) still get an array, just bounded.
const FOLLOW_PAGE_MAX = 2000;

function followPageArgs(limit?: number, cursor?: string) {
  const requested = Number.isFinite(limit) ? (limit as number) : FOLLOW_PAGE_MAX;
  const take = Math.min(Math.max(Math.trunc(requested), 1), FOLLOW_PAGE_MAX);
  return {
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

export async function getFollowers(
  userId: string,
  viewerId: string,
  opts: { limit?: number; cursor?: string } = {},
) {
  const rows = await prisma.follow.findMany({
    where: { followingId: userId },
    select: {
      id: true,
      createdAt: true,
      follower: {
        select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    ...followPageArgs(opts.limit, opts.cursor),
  });
  const { iFollow, followsMe } = await viewerRelationships(
    viewerId,
    rows.map((r) => r.follower.id),
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    follower: {
      ...r.follower,
      isFollowedByMe: iFollow.has(r.follower.id),
      isFollowingMe: followsMe.has(r.follower.id),
    },
  }));
}

export async function getFollowing(
  userId: string,
  viewerId: string,
  opts: { limit?: number; cursor?: string } = {},
) {
  const rows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: {
      id: true,
      createdAt: true,
      following: {
        select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    ...followPageArgs(opts.limit, opts.cursor),
  });
  const { iFollow, followsMe } = await viewerRelationships(
    viewerId,
    rows.map((r) => r.following.id),
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    following: {
      ...r.following,
      isFollowedByMe: iFollow.has(r.following.id),
      isFollowingMe: followsMe.has(r.following.id),
    },
  }));
}

export async function isFollowing(followerId: string, followingId: string) {
  const follow = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });
  return !!follow;
}

export async function getFollowerCount(userId: string) {
  return prisma.follow.count({ where: { followingId: userId } });
}

export async function getFollowingCount(userId: string) {
  return prisma.follow.count({ where: { followerId: userId } });
}
