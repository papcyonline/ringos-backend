import { prisma } from '../../config/database';
import { NotFoundError } from '../../shared/errors';
import { UpdatePreferenceInput, UpdateAvailabilityInput, UpdatePrivacyInput, UpdateProfileInput } from './user.schema';

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
      profession: true,
      gender: true,
      location: true,
      status: true,
      availabilityNote: true,
      isAnonymous: true,
      isOnline: true,
      lastSeenAt: true,
      availableFor: true,
      availableUntil: true,
      isVerified: true,
      verifiedAt: true,
      verifiedRole: true,
      isProfilePublic: true,
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
      _count: {
        select: {
          followsReceived: true,
          followsInitiated: true,
        },
      },
    },
  });

  if (!user) throw new NotFoundError('User not found');
  return {
    ...user,
    followerCount: user._count.followsReceived,
    followingCount: user._count.followsInitiated,
  };
}

export async function getUserById(targetId: string, currentUserId: string) {
  const user = await prisma.user.findUnique({
    where: { id: targetId },
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
      availableUntil: true,
      isVerified: true,
      verifiedRole: true,
      isProfilePublic: true,
      createdAt: true,
      _count: { select: { followsReceived: true, likesReceived: true } },
    },
  });

  if (!user) throw new NotFoundError('User not found');

  const [followRecord, likeRecord] = await Promise.all([
    prisma.follow.findFirst({
      where: { followerId: currentUserId, followingId: targetId },
    }),
    prisma.like.findFirst({
      where: { likerId: currentUserId, likedId: targetId },
    }),
  ]);

  const isPrivate = !user.isProfilePublic;
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: isPrivate ? null : user.bio,
    profession: isPrivate ? null : user.profession,
    gender: user.gender,
    location: isPrivate ? null : user.location,
    status: user.status,
    availabilityNote: isPrivate ? null : user.availabilityNote,
    isOnline: user.isOnline,
    lastSeenAt: user.lastSeenAt,
    availableFor: user.availableFor,
    availableUntil: user.availableUntil,
    isVerified: user.isVerified,
    verifiedRole: user.verifiedRole,
    isProfilePublic: user.isProfilePublic,
    followerCount: user._count.followsReceived,
    isFollowedByMe: !!followRecord,
    likeCount: user._count.likesReceived,
    isLikedByMe: !!likeRecord,
    createdAt: user.createdAt,
  };
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

  const users = await prisma.user.findMany({
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
      availableUntil: true,
      isVerified: true,
      verifiedRole: true,
      isProfilePublic: true,
      preference: { select: { language: true } },
      _count: { select: { followsReceived: true, likesReceived: true } },
    },
    orderBy: [{ isOnline: 'desc' }, { lastSeenAt: 'desc' }],
  });

  // Get who the current user follows and likes
  const [following, likes] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: currentUserId },
      select: { followingId: true },
    }),
    prisma.like.findMany({
      where: { likerId: currentUserId },
      select: { likedId: true },
    }),
  ]);
  const followingSet = new Set(following.map((f) => f.followingId));
  const likedSet = new Set(likes.map((l) => l.likedId));

  return users.map((user) => {
    const isPrivate = !user.isProfilePublic;
    return {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: isPrivate ? null : user.bio,
      profession: isPrivate ? null : user.profession,
      gender: user.gender,
      location: isPrivate ? null : user.location,
      status: user.status,
      availabilityNote: isPrivate ? null : user.availabilityNote,
      isOnline: user.isOnline,
      lastSeenAt: user.lastSeenAt,
      availableFor: user.availableFor,
      availableUntil: user.availableUntil,
      isVerified: user.isVerified,
      verifiedRole: user.verifiedRole,
      isProfilePublic: user.isProfilePublic,
      language: user.preference?.language ?? 'en',
      followerCount: user._count.followsReceived,
      isFollowedByMe: followingSet.has(user.id),
      likeCount: user._count.likesReceived,
      isLikedByMe: likedSet.has(user.id),
    };
  });
}

export async function updateAvailability(userId: string, data: UpdateAvailabilityInput) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: {
      availableFor: data.availableFor,
      availabilityNote: data.availabilityNote ?? null,
      status: data.status ?? 'available',
      availableUntil: data.availableUntil ? new Date(data.availableUntil) : null,
    },
    select: {
      id: true,
      availableFor: true,
      availabilityNote: true,
      status: true,
      availableUntil: true,
    },
  });
}

export async function stopAvailability(userId: string) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: {
      availableFor: ['text'],
      availabilityNote: null,
      status: 'available',
      availableUntil: null,
    },
    select: {
      id: true,
      availableFor: true,
      availabilityNote: true,
      status: true,
      availableUntil: true,
    },
  });
}

export async function expireAvailabilities() {
  const now = new Date();
  const expired = await prisma.user.findMany({
    where: {
      availableUntil: { lt: now },
    },
    select: { id: true },
  });

  if (expired.length === 0) return [];

  const ids = expired.map((u) => u.id);

  await prisma.user.updateMany({
    where: { id: { in: ids } },
    data: {
      availableFor: ['text'],
      availabilityNote: null,
      status: 'available',
      availableUntil: null,
    },
  });

  return ids;
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

export async function updatePrivacy(userId: string, data: UpdatePrivacyInput) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: { isProfilePublic: data.isProfilePublic },
    select: { id: true, isProfilePublic: true },
  });
}

export async function updateProfile(userId: string, data: UpdateProfileInput) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      profession: true,
      gender: true,
      location: true,
    },
  });
}

export async function setVerified(userId: string) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: { isVerified: true, verifiedAt: new Date() },
    select: { id: true, isVerified: true, verifiedAt: true, verifiedRole: true },
  });
}

export async function removeVerified(userId: string) {
  await findUserOrThrow(userId);
  return prisma.user.update({
    where: { id: userId },
    data: { isVerified: false, verifiedAt: null },
    select: { id: true, isVerified: true, verifiedAt: true, verifiedRole: true },
  });
}

export async function deleteAccount(userId: string) {
  await findUserOrThrow(userId);
  await prisma.user.delete({ where: { id: userId } });
}
