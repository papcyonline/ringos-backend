import { prisma } from '../../config/database';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';

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

  return prisma.follow.create({
    data: { followerId, followingId },
    select: { id: true, followerId: true, followingId: true, createdAt: true },
  });
}

export async function unfollowUser(followerId: string, followingId: string) {
  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });
  if (!existing) throw new NotFoundError('Not following this user');

  await prisma.follow.delete({
    where: { followerId_followingId: { followerId, followingId } },
  });
}

export async function getFollowers(userId: string) {
  return prisma.follow.findMany({
    where: { followingId: userId },
    select: {
      id: true,
      createdAt: true,
      follower: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isOnline: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getFollowing(userId: string) {
  return prisma.follow.findMany({
    where: { followerId: userId },
    select: {
      id: true,
      createdAt: true,
      following: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isOnline: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
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
