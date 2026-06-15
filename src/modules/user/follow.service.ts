import { prisma } from '../../config/database';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';
import { invalidateFeedCache } from '../story/story.service';

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

export async function getFollowers(userId: string, viewerId: string) {
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

export async function getFollowing(userId: string, viewerId: string) {
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
