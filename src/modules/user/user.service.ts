import { prisma } from '../../config/database';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { UpdatePreferenceInput, UpdateAvailabilityInput, UpdatePrivacyInput, UpdateProfileInput } from './user.schema';
import { isBlocked } from '../safety/safety.service';

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
      lastNameChangeAt: true,
      phoneLookup: true,
      isProfilePublic: true,
      hideOnlineStatus: true,
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
      hideOnlineStatus: true,
      flagCount: true,
      createdAt: true,
      _count: { select: { followsReceived: true, likesReceived: true } },
    },
  });

  if (!user) throw new NotFoundError('User not found');

  // Check if either user has blocked the other
  if (currentUserId !== targetId) {
    const blocked = await isBlocked(currentUserId, targetId);
    if (blocked) {
      throw new ForbiddenError('User not available');
    }
  }

  const [followRecord, likeRecord] = await Promise.all([
    prisma.follow.findFirst({
      where: { followerId: currentUserId, followingId: targetId },
    }),
    prisma.like.findFirst({
      where: { likerId: currentUserId, likedId: targetId },
    }),
  ]);

  const isPrivate = !user.isProfilePublic;
  const hideOnline = user.hideOnlineStatus && targetId !== currentUserId;
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
    isOnline: hideOnline ? false : user.isOnline,
    lastSeenAt: hideOnline ? null : user.lastSeenAt,
    availableFor: user.availableFor,
    availableUntil: user.availableUntil,
    isVerified: user.isVerified,
    verifiedRole: user.verifiedRole,
    isProfilePublic: user.isProfilePublic,
    followerCount: user._count.followsReceived,
    isFollowedByMe: !!followRecord,
    likeCount: user._count.likesReceived,
    isLikedByMe: !!likeRecord,
    reportCount: user.flagCount,
    createdAt: user.createdAt,
  };
}

export async function listUsers(currentUserId: string, page = 1, limit = 50) {
  const blocks = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }],
    },
    select: { blockerId: true, blockedId: true },
  });

  const blockedIds = blocks.map((b) =>
    b.blockerId === currentUserId ? b.blockedId : b.blockerId,
  );

  const skip = (page - 1) * limit;

  const userWhere = {
    id: { notIn: [currentUserId, ...blockedIds] },
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where: userWhere,
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
        hideOnlineStatus: true,
        flagCount: true,
        preference: { select: { language: true } },
        _count: { select: { followsReceived: true, likesReceived: true } },
      },
      orderBy: [{ isOnline: 'desc' }, { lastSeenAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where: userWhere }),
  ]);

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

  const data = users.map((user) => {
    const isPrivate = !user.isProfilePublic;
    const hideOnline = user.hideOnlineStatus;
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
      isOnline: hideOnline ? false : user.isOnline,
      lastSeenAt: hideOnline ? null : user.lastSeenAt,
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
      reportCount: user.flagCount,
    };
  });

  return { users: data, total, page, limit };
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
    data: {
      ...(data.isProfilePublic !== undefined && { isProfilePublic: data.isProfilePublic }),
      ...(data.hideOnlineStatus !== undefined && { hideOnlineStatus: data.hideOnlineStatus }),
    },
    select: { id: true, isProfilePublic: true, hideOnlineStatus: true },
  });
}

const NAME_CHANGE_COOLDOWN_DAYS = 20;

export async function updateProfile(userId: string, data: UpdateProfileInput) {
  const user = await findUserOrThrow(userId);

  const isChangingName = data.displayName && data.displayName !== user.displayName;

  // 20-day cooldown for display name changes (all users)
  if (isChangingName) {
    const lastChange = (user as any).lastNameChangeAt as Date | null;
    if (lastChange) {
      const daysSince = (Date.now() - lastChange.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < NAME_CHANGE_COOLDOWN_DAYS) {
        const daysLeft = Math.ceil(NAME_CHANGE_COOLDOWN_DAYS - daysSince);
        throw new ForbiddenError(`You can change your username again in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`);
      }
    }

    // Check uniqueness
    const { checkUsernameAvailable } = await import('../auth/auth.service');
    const available = await checkUsernameAvailable(data.displayName!, userId);
    if (!available) {
      throw new ForbiddenError('Username is already taken');
    }
  }

  // Only verified users can change location
  if (!user.isVerified && data.location !== undefined && data.location !== user.location) {
    throw new ForbiddenError('Only verified users can change their location');
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      ...data,
      ...(isChangingName && { lastNameChangeAt: new Date() }),
    },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      profession: true,
      gender: true,
      location: true,
      lastNameChangeAt: true,
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

export async function adminSetVerified(identifier: string, verified: boolean, role?: string) {
  // Find user by ID, email, or displayName
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { id: identifier },
        { email: identifier },
        { displayName: { equals: identifier, mode: 'insensitive' } },
      ],
    },
  });
  if (!user) throw new NotFoundError('User not found');

  return prisma.user.update({
    where: { id: user.id },
    data: {
      isVerified: verified,
      verifiedAt: verified ? new Date() : null,
      verifiedRole: verified ? (role || null) : null,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      isVerified: true,
      verifiedAt: true,
      verifiedRole: true,
    },
  });
}

export async function deleteAccount(userId: string) {
  await findUserOrThrow(userId);
  await prisma.user.delete({ where: { id: userId } });
}

// ─── Phone & Contact Sync ────────────────────────────────

export async function setPhoneHash(userId: string, phoneHash: string) {
  // Check if hash is already taken by another user
  const existing = await prisma.user.findFirst({
    where: { phoneLookup: phoneHash, NOT: { id: userId } },
  });
  if (existing) {
    throw new ForbiddenError('This phone number is already linked to another account');
  }

  return prisma.user.update({
    where: { id: userId },
    data: { phoneLookup: phoneHash },
    select: { id: true, phoneLookup: true },
  });
}

export async function removePhoneHash(userId: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { phoneLookup: null },
    select: { id: true, phoneLookup: true },
  });
}

export async function syncContacts(userId: string, hashes: string[]) {
  const { getBlockedUserIds } = await import('../spotlight/spotlight.service');
  const blockedIds = await getBlockedUserIds(userId);

  const matches = await prisma.user.findMany({
    where: {
      phoneLookup: { in: hashes },
      id: { notIn: [userId, ...Array.from(blockedIds)] },
    },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      isVerified: true,
      isOnline: true,
    },
  });

  return matches;
}
