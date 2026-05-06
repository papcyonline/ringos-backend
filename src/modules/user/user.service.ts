import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { UpdatePreferenceInput, UpdateAvailabilityInput, UpdatePrivacyInput, UpdateProfileInput } from './user.schema';
import { isBlocked } from '../safety/safety.service';
import { getLimits, isPro } from '../../shared/usage.service';

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
      hideReadReceipts: true,
      moderation: {
        select: {
          banStatus: true,
          banExpiresAt: true,
        },
      },
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
    banStatus: user.moderation?.banStatus ?? 'NONE',
    banExpiresAt: user.moderation?.banExpiresAt ?? null,
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
      moderation: {
        select: { flagCount: true },
      },
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
    reportCount: user.moderation?.flagCount ?? 0,
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

  // Users must have actually finished onboarding to appear in the
  // People tab. isAnonymous flips to false inside setUsername — but
  // we ALSO require a non-empty displayName + bio so a legacy row
  // somehow flagged complete without any actual profile content
  // (data drift, partial migration, manual DB tinkering) doesn't
  // surface as a ghost user. The bio check covers both NULL and ''
  // for the nullable column; displayName is non-null in the schema
  // so only the empty-string check matters there.
  const userWhere = {
    id: { notIn: [currentUserId, ...blockedIds] },
    isAnonymous: false,
    displayName: { not: '' },
    bio: { not: null, notIn: [''] },
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
        moderation: {
          select: { flagCount: true },
        },
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
      reportCount: 0,
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

  // hideReadReceipts is a Pro-only feature
  if (data.hideReadReceipts === true) {
    const pro = await isPro(userId);
    if (!pro) {
      throw new ForbiddenError('Hide read receipts requires Yomeet Pro');
    }
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.isProfilePublic !== undefined && { isProfilePublic: data.isProfilePublic }),
      ...(data.hideOnlineStatus !== undefined && { hideOnlineStatus: data.hideOnlineStatus }),
      ...(data.hideReadReceipts !== undefined && { hideReadReceipts: data.hideReadReceipts }),
    },
    select: { id: true, isProfilePublic: true, hideOnlineStatus: true, hideReadReceipts: true },
  });
}

const NAME_CHANGE_COOLDOWN_DAYS = 20;

export async function updateProfile(userId: string, data: UpdateProfileInput) {
  const user = await findUserOrThrow(userId);

  // Enforce bio length limit based on Pro status
  if (data.bio) {
    const limits = await getLimits(userId);
    if (data.bio.length > limits.bioLength) {
      throw new ForbiddenError(`Bio exceeds ${limits.bioLength} character limit. Upgrade to Pro for longer bios.`);
    }
  }

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
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isVerified: true, verifiedAt: new Date() },
    select: { id: true, isVerified: true, verifiedAt: true, verifiedRole: true },
  });

  // Auto-verify all channels where this user is admin
  const adminChannels = await prisma.conversationParticipant.findMany({
    where: { userId, role: 'ADMIN', leftAt: null, conversation: { isChannel: true, status: 'ACTIVE' } },
    select: { conversationId: true },
  });
  if (adminChannels.length > 0) {
    await prisma.conversation.updateMany({
      where: { id: { in: adminChannels.map((c) => c.conversationId) } },
      data: { isVerified: true },
    });
  }

  return user;
}

export async function removeVerified(userId: string) {
  await findUserOrThrow(userId);
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isVerified: false, verifiedAt: null },
    select: { id: true, isVerified: true, verifiedAt: true, verifiedRole: true },
  });

  // Remove verification from channels where this user is admin
  const adminChannels = await prisma.conversationParticipant.findMany({
    where: { userId, role: 'ADMIN', leftAt: null, conversation: { isChannel: true, status: 'ACTIVE' } },
    select: { conversationId: true },
  });
  if (adminChannels.length > 0) {
    await prisma.conversation.updateMany({
      where: { id: { in: adminChannels.map((c) => c.conversationId) } },
      data: { isVerified: false },
    });
  }

  return user;
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

  const updated = await prisma.user.update({
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

  // Cascade verification to all channels where this user is admin
  const adminChannels = await prisma.conversationParticipant.findMany({
    where: { userId: user.id, role: 'ADMIN', leftAt: null, conversation: { isChannel: true, status: 'ACTIVE' } },
    select: { conversationId: true },
  });
  if (adminChannels.length > 0) {
    await prisma.conversation.updateMany({
      where: { id: { in: adminChannels.map((c) => c.conversationId) } },
      data: { isVerified: verified },
    });
  }

  return updated;
}

export async function deleteAccount(userId: string) {
  const user = await findUserOrThrow(userId);
  const email = (user as any).email as string | null;
  const displayName = (user as any).displayName as string | null;

  // Collect all media file references BEFORE deleting the user (cascade will remove records)
  const [postMedia, storySlides, userAvatar, ownedChannels] = await Promise.all([
    // Post media (images/videos uploaded by this user)
    prisma.postMedia.findMany({
      where: { post: { authorId: userId } },
      select: { cloudinaryId: true, url: true },
    }),
    // Story slides
    prisma.storySlide.findMany({
      where: { story: { userId } },
      select: { cloudinaryId: true, mediaUrl: true },
    }),
    // User avatar URL
    Promise.resolve((user as any).avatarUrl as string | null),
    // Channels where user is the sole admin (should be deleted)
    prisma.conversation.findMany({
      where: {
        type: 'GROUP',
        isChannel: true,
        status: 'ACTIVE',
        participants: { some: { userId, role: 'ADMIN', leftAt: null } },
      },
      select: { id: true, avatarUrl: true, bannerUrl: true },
    }),
  ]);

  // Delete the user (cascades all related records)
  await prisma.user.delete({ where: { id: userId } });

  // Soft-delete owned channels (set status to ENDED)
  for (const ch of ownedChannels) {
    // Check if any other admins remain
    const otherAdmins = await prisma.conversationParticipant.count({
      where: { conversationId: ch.id, role: 'ADMIN', leftAt: null },
    });
    if (otherAdmins === 0) {
      await prisma.conversation.update({
        where: { id: ch.id },
        data: { status: 'ENDED' },
      });
    }
  }

  // Clean up external media storage (fire-and-forget, don't block response)
  _cleanupUserMedia(postMedia, storySlides, userAvatar, ownedChannels).catch((err) =>
    logger.error({ err, userId }, 'Failed to clean up media files after account deletion'));

  logger.info({ userId, email }, 'Account deleted');
  return { email, displayName };
}

/**
 * Clean up all media files from Cloudinary/R2 for a deleted user.
 */
async function _cleanupUserMedia(
  postMedia: { cloudinaryId: string; url: string }[],
  storySlides: { cloudinaryId: string; mediaUrl: string }[],
  avatarUrl: string | null,
  channels: { avatarUrl: string | null; bannerUrl: string | null }[],
) {
  const { deleteFile } = await import('../../shared/cloudinary.service');

  // Delete post media
  for (const m of postMedia) {
    if (m.cloudinaryId) {
      const isVideo = m.url.includes('/video/') || m.url.endsWith('.mp4');
      deleteFile(m.cloudinaryId, isVideo ? 'video' : 'image').catch(() => {});
    }
  }

  // Delete story slides
  for (const s of storySlides) {
    if (s.cloudinaryId) {
      const isVideo = s.mediaUrl.includes('/video/') || s.mediaUrl.endsWith('.mp4');
      deleteFile(s.cloudinaryId, isVideo ? 'video' : 'image').catch(() => {});
    }
  }

  // Delete user avatar
  if (avatarUrl && avatarUrl.includes('cloudinary.com')) {
    const match = avatarUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    if (match) deleteFile(match[1]).catch(() => {});
  }

  // Delete channel avatars/banners
  for (const ch of channels) {
    for (const url of [ch.avatarUrl, ch.bannerUrl]) {
      if (url && url.includes('cloudinary.com')) {
        const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
        if (match) deleteFile(match[1]).catch(() => {});
      }
    }
  }
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
      lastSeenAt: true,
      status: true,
      availabilityNote: true,
      availableFor: true,
    },
  });

  return matches;
}
