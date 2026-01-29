import { prisma } from '../../config/database';
import { NotFoundError } from '../../shared/errors';
import { UpdatePreferenceInput, UpdateAvailabilityInput } from './user.schema';

async function findUserOrThrow(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      gender: true,
      location: true,
      status: true,
      isAnonymous: true,
      isOnline: true,
      lastSeenAt: true,
      availableFor: true,
      banStatus: true,
      banExpiresAt: true,
      createdAt: true,
      updatedAt: true,
      preference: {
        select: {
          mood: true,
          language: true,
          timezone: true,
          topics: true,
        },
      },
    },
  });

  if (!user) throw new NotFoundError('User not found');
  return user;
}

export async function listUsers(currentUserId: string) {
  const blocks = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }],
    },
    select: { blockerId: true, blockedId: true },
  });

  const blockedIds = blocks.map((b) =>
    b.blockerId === currentUserId ? b.blockedId : b.blockerId,
  );

  return prisma.user.findMany({
    where: {
      id: { notIn: [currentUserId, ...blockedIds] },
    },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      profession: true,
      gender: true,
      location: true,
      status: true,
      availabilityNote: true,
      isOnline: true,
      lastSeenAt: true,
      availableFor: true,
    },
    orderBy: [{ isOnline: 'desc' }, { lastSeenAt: 'desc' }],
  });
}

export async function updateAvailability(userId: string, data: UpdateAvailabilityInput) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: { availableFor: data.availableFor },
    select: { id: true, availableFor: true },
  });
}

export async function uploadAvatar(userId: string, avatarUrl: string) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: { avatarUrl },
    select: { id: true, avatarUrl: true },
  });
}

export async function setOnline(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { isOnline: true },
  });
}

export async function setOffline(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { isOnline: false, lastSeenAt: new Date() },
  });
}

export async function updatePreference(userId: string, data: UpdatePreferenceInput) {
  await findUserOrThrow(userId);
  return prisma.userPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
    select: {
      mood: true,
      language: true,
      timezone: true,
      topics: true,
      updatedAt: true,
    },
  });
}

export async function deleteAccount(userId: string) {
  await findUserOrThrow(userId);
  await prisma.user.delete({ where: { id: userId } });
}
