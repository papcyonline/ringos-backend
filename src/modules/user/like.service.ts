import { prisma } from '../../config/database';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';

export async function likeUser(likerId: string, likedId: string) {
  if (likerId === likedId) {
    throw new BadRequestError('Cannot like yourself');
  }

  const target = await prisma.user.findUnique({ where: { id: likedId } });
  if (!target) throw new NotFoundError('User not found');

  const existing = await prisma.like.findUnique({
    where: { likerId_likedId: { likerId, likedId } },
  });
  if (existing) throw new ConflictError('Already liked this user');

  return prisma.like.create({
    data: { likerId, likedId },
    select: { id: true, likerId: true, likedId: true, createdAt: true },
  });
}

export async function unlikeUser(likerId: string, likedId: string) {
  const existing = await prisma.like.findUnique({
    where: { likerId_likedId: { likerId, likedId } },
  });
  if (!existing) throw new NotFoundError('Not liked this user');

  await prisma.like.delete({
    where: { likerId_likedId: { likerId, likedId } },
  });
}

export async function getLikeCount(userId: string) {
  return prisma.like.count({ where: { likedId: userId } });
}

export async function isLikedBy(likerId: string, likedId: string) {
  const like = await prisma.like.findUnique({
    where: { likerId_likedId: { likerId, likedId } },
  });
  return !!like;
}
