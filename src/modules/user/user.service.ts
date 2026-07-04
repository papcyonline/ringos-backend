import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { UpdatePreferenceInput, UpdateAvailabilityInput, UpdatePrivacyInput, UpdateProfileInput } from './user.schema';
import { isBlocked } from '../safety/safety.service';
import { getLimits, isPro } from '../../shared/usage.service';
import { isReservedUsername } from '../../shared/reserved-usernames';
import * as cache from '../../shared/redis.service';

async function findUserOrThrow(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

/**
 * Assemble a machine-readable export of everything personal we hold about a
 * user (GDPR/CCPA right of access & portability). Excludes secrets — password
 * hash, provider IDs, phone hashes, 2FA secret — and other users' private data.
 */
export async function exportUserData(userId: string) {
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, displayName: true, avatarUrl: true, coverUrl: true,
      bio: true, profession: true, location: true, profileLinks: true,
      dateOfBirth: true, status: true, availabilityNote: true,
      authProvider: true, isVerified: true, verifiedRole: true,
      isProfilePublic: true, hideOnlineStatus: true, hideReadReceipts: true,
      twoFactorEnabled: true, createdAt: true, updatedAt: true,
    },
  });
  if (!account) throw new NotFoundError('User not found');

  const [posts, stories, reels, comments, messagesSent, following, followers, blockedUsers, reportsMade] =
    await Promise.all([
      prisma.post.findMany({ where: { authorId: userId }, select: { id: true, content: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.story.findMany({ where: { userId }, select: { id: true, createdAt: true, expiresAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.reel.findMany({ where: { userId }, select: { id: true, caption: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.reelComment.findMany({ where: { userId }, select: { id: true, content: true, reelId: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.message.findMany({ where: { senderId: userId }, select: { id: true, content: true, conversationId: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true, createdAt: true } }),
      prisma.follow.findMany({ where: { followingId: userId }, select: { followerId: true, createdAt: true } }),
      prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true, createdAt: true } }),
      prisma.report.findMany({ where: { reporterId: userId }, select: { id: true, reason: true, contentType: true, contentId: true, createdAt: true } }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    account,
    posts,
    stories,
    reels,
    comments,
    messagesSent,
    following,
    followers,
    blockedUsers,
    reportsMade,
  };
}

// Own-profile cache. Short TTL backstop + explicit invalidation on the common
// content edits (see invalidateProfileCache) so changes show promptly. Volatile
// presence fields can lag up to the TTL, which is irrelevant for one's own
// profile. No-ops when Redis is unconfigured (cache.get returns null).
const PROFILE_CACHE_TTL_SEC = 60;

export async function invalidateProfileCache(userId: string) {
  // Both the own-profile view and the shared viewer-independent core.
  await Promise.all([
    cache.del(cache.cacheKeys.userProfile(userId)),
    cache.del(cache.cacheKeys.user(userId)),
  ]);
}

export async function getProfile(userId: string) {
  const cacheKey = cache.cacheKeys.userProfile(userId);
  const cachedProfile = await cache.get<Record<string, any>>(cacheKey, true);
  if (cachedProfile) return cachedProfile;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      // Own profile only (GET /me). getUserCore — which serves OTHER users'
      // profiles — deliberately does NOT select email.
      email: true,
      displayName: true,
      avatarUrl: true,
      coverUrl: true,
      bio: true,
      profession: true,
      gender: true,
      location: true,
      profileLinks: true,
      acceptedLegalVersion: true,
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
      messagePrivacy: true,
      moderation: {
        select: {
          banStatus: true,
          banExpiresAt: true,
          flagCount: true,
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
          likesReceived: true,
        },
      },
    },
  });

  if (!user) throw new NotFoundError('User not found');
  const result = {
    ...user,
    profileLinks: (user as any).profileLinks ?? [],
    banStatus: user.moderation?.banStatus ?? 'NONE',
    banExpiresAt: user.moderation?.banExpiresAt ?? null,
    reportCount: user.moderation?.flagCount ?? 0,
    followerCount: user._count.followsReceived,
    followingCount: user._count.followsInitiated,
    likeCount: user._count.likesReceived,
  };
  await cache.set(cacheKey, result, PROFILE_CACHE_TTL_SEC);
  return result;
}

// Viewer-independent core of a user — the heavy findUnique behind getUserById.
// Cached by id so every viewer of the same profile reuses it; invalidated on
// that user's content edits via invalidateProfileCache. The per-viewer
// block/follow/like checks in getUserById always run live below.
const USER_CORE_TTL_SEC = 60;

async function getUserCore(targetId: string) {
  const key = cache.cacheKeys.user(targetId);
  const cached = await cache.get<Record<string, any>>(key, true);
  if (cached) return cached;
  const user = await prisma.user.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      coverUrl: true,
      bio: true,
      profession: true,
      gender: true,
      location: true,
      profileLinks: true,
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
  if (user) await cache.set(key, user, USER_CORE_TTL_SEC);
  return user;
}

export async function getUserById(targetId: string, currentUserId: string) {
  const user = await getUserCore(targetId);

  if (!user) throw new NotFoundError('User not found');

  // Check if either user has blocked the other
  if (currentUserId !== targetId) {
    const blocked = await isBlocked(currentUserId, targetId);
    if (blocked) {
      throw new ForbiddenError('User not available');
    }
  }

  const [followRecord, reverseFollowRecord, likeRecord] = await Promise.all([
    prisma.follow.findFirst({
      where: { followerId: currentUserId, followingId: targetId },
    }),
    prisma.follow.findFirst({
      where: { followerId: targetId, followingId: currentUserId },
    }),
    prisma.like.findFirst({
      where: { likerId: currentUserId, likedId: targetId },
    }),
  ]);

  // Instagram-style privacy: a private profile is "locked" to viewers who
  // don't follow them (and isn't the owner). Followers see the full profile;
  // non-followers get only name/avatar/verified + follower count + the follow
  // button. Everything else is hidden server-side.
  const isFollower = !!followRecord;
  const isSelf = targetId === currentUserId;
  const locked = !user.isProfilePublic && !isFollower && !isSelf;
  const hideOnline = user.hideOnlineStatus && targetId !== currentUserId;
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    isVerified: user.isVerified,
    verifiedRole: user.verifiedRole,
    isProfilePublic: user.isProfilePublic,
    isLocked: locked,
    // Always visible (Instagram shows these on locked profiles).
    followerCount: user._count.followsReceived,
    isFollowedByMe: isFollower,
    isFollowingMe: !!reverseFollowRecord,
    createdAt: user.createdAt,
    // Hidden when locked.
    bio: locked ? null : user.bio,
    profileLinks: locked ? [] : (user.profileLinks ?? []),
    profession: locked ? null : user.profession,
    gender: locked ? null : user.gender,
    location: locked ? null : user.location,
    status: locked ? null : user.status,
    availabilityNote: locked ? null : user.availabilityNote,
    isOnline: locked ? false : (hideOnline ? false : user.isOnline),
    lastSeenAt: locked ? null : (hideOnline ? null : user.lastSeenAt),
    availableFor: locked ? [] : user.availableFor,
    availableUntil: locked ? null : user.availableUntil,
    likeCount: locked ? 0 : user._count.likesReceived,
    isLikedByMe: locked ? false : !!likeRecord,
    reportCount: user.moderation?.flagCount ?? 0,
  };
}

// People-list cache — see listUsers. Short TTL because the rows carry
// presence + follow state; the client also receives live presence over
// sockets, so a few seconds of staleness in the ordering is harmless.
const USER_LIST_CACHE_TTL_SEC = 10;
const userListCacheKey = (viewerId: string, limit: number) =>
  `users:list:${viewerId}:${limit}`;

export async function listUsers(
  currentUserId: string,
  page = 1,
  limit = 50,
  q?: string,
) {
  // Cache only the hot path: first page, no search query, keyed per viewer.
  // Self-expiring (30s) so no explicit invalidation is needed, and it no-ops
  // cleanly when Redis isn't configured (cache.get returns null → cache miss).
  const trimmedQ = q?.trim() ?? '';
  const cacheable = page === 1 && trimmedQ.length === 0;
  const cacheKey = userListCacheKey(currentUserId, limit);
  if (cacheable) {
    const cached = await cache.get<{
      users: any[];
      total: number;
      page: number;
      limit: number;
    }>(cacheKey, true);
    if (cached) return cached;
  }

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
  // People tab. isAnonymous flips to false inside setUsername, and we
  // ALSO require a non-empty displayName so a legacy row somehow
  // flagged complete without any profile content (data drift, partial
  // migration, manual DB tinkering) doesn't surface as a ghost user.
  //
  // NOTE: bio is intentionally NOT a visibility gate. It previously
  // was (bio NOT NULL / != ''), but that silently hid every real user
  // who had no bio — legacy/social accounts and anyone who cleared
  // their bio in profile edit. Bio-less users now get a default bio
  // ("Available for chat") at signup + via backfill, and are visible
  // regardless. See scripts/backfill-default-bio.ts.
  const userWhere: any = {
    id: { notIn: [currentUserId, ...blockedIds] },
    isAnonymous: false,
    displayName: { not: '' },
  };
  if (trimmedQ.length > 0) {
    userWhere.OR = [
      { displayName: { contains: trimmedQ, mode: 'insensitive' } },
      { bio: { contains: trimmedQ, mode: 'insensitive' } },
    ];
  }

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

  // Get who the current user follows / who follows them / who they like.
  // `followers` is scoped to the current page of users so we know which
  // of the visible rows already follow the viewer ("Follow back").
  const pageUserIds = users.map((u) => u.id);
  const [following, followers, likes] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: currentUserId },
      select: { followingId: true },
    }),
    prisma.follow.findMany({
      where: { followerId: { in: pageUserIds }, followingId: currentUserId },
      select: { followerId: true },
    }),
    prisma.like.findMany({
      where: { likerId: currentUserId },
      select: { likedId: true },
    }),
  ]);
  const followingSet = new Set(following.map((f) => f.followingId));
  const followersSet = new Set(followers.map((f) => f.followerId));
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
      isFollowingMe: followersSet.has(user.id),
      likeCount: user._count.likesReceived,
      isLikedByMe: likedSet.has(user.id),
      reportCount: user.moderation?.flagCount ?? 0,
    };
  });

  const result = { users: data, total, page, limit };
  if (cacheable) await cache.set(cacheKey, result, USER_LIST_CACHE_TTL_SEC);
  return result;
}

export async function updateAvailability(userId: string, data: UpdateAvailabilityInput) {
  await findUserOrThrow(userId);
  const updated = await prisma.user.update({
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
  await invalidateProfileCache(userId);
  return updated;
}

export async function stopAvailability(userId: string) {
  await findUserOrThrow(userId);
  const updated = await prisma.user.update({
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
  await invalidateProfileCache(userId);
  return updated;
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
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl },
    select: { id: true, avatarUrl: true },
  });
  await invalidateProfileCache(userId);
  return updated;
}

export async function uploadCover(userId: string, coverUrl: string) {
  await findUserOrThrow(userId);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { coverUrl },
    select: { id: true, coverUrl: true },
  });
  await invalidateProfileCache(userId);
  return updated;
}

// updateMany (not update) so a presence flip for a user whose row no
// longer exists — e.g. a deleted account whose socket reconnects with a
// still-valid token — is a harmless no-op instead of a thrown P2025.
export async function setOnline(userId: string) {
  await prisma.user.updateMany({
    where: { id: userId },
    data: { isOnline: true },
  });
}

// updateMany (not update) so a disconnect cleanup for a user whose row no
// longer exists (deleted account, stale socket) is a no-op rather than a
// thrown P2025 — a disconnect handler must never throw.
export async function setOffline(userId: string) {
  await prisma.user.updateMany({
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
  const user = await findUserOrThrow(userId);

  // Only verified users may hide their profile from the directory.
  // Keeps unverified accounts discoverable and accountable.
  if (data.isProfilePublic === false && !user.isVerified) {
    throw new ForbiddenError('Only verified accounts can make their profile private');
  }

  // hideReadReceipts is a Pro-only feature
  if (data.hideReadReceipts === true) {
    const pro = await isPro(userId);
    if (!pro) {
      throw new ForbiddenError('Hide read receipts requires Yomeet Pro');
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.isProfilePublic !== undefined && { isProfilePublic: data.isProfilePublic }),
      ...(data.hideOnlineStatus !== undefined && { hideOnlineStatus: data.hideOnlineStatus }),
      ...(data.hideReadReceipts !== undefined && { hideReadReceipts: data.hideReadReceipts }),
    },
    select: { id: true, isProfilePublic: true, hideOnlineStatus: true, hideReadReceipts: true },
  });
  await invalidateProfileCache(userId);
  return updated;
}

const NAME_CHANGE_COOLDOWN_DAYS = 20;

export async function updateMessagePrivacy(
  userId: string,
  value: 'EVERYONE' | 'FOLLOWING' | 'NOBODY',
) {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { messagePrivacy: value },
    select: { id: true, messagePrivacy: true },
  });
  await invalidateProfileCache(userId);
  return updated;
}

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

    if (isReservedUsername(data.displayName!)) {
      throw new ForbiddenError('That username is reserved and cannot be used');
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

  // Sanitize profile links before persisting. Schema already validated
  // shape/length; here we normalize values and enforce safe URL schemes so
  // these tappable links can't carry e.g. javascript: payloads to viewers.
  const { profileLinks, ...rest } = data;
  let sanitizedLinks: { type: string; label: string; value: string }[] | undefined;
  if (profileLinks !== undefined) {
    sanitizedLinks = (profileLinks ?? [])
      .map((l) => {
        const label = l.label.trim();
        let value = l.value.trim();
        if (!label || !value) return null;
        if (l.type === 'website') {
          if (!/^https?:\/\//i.test(value)) {
            // Reject any other explicit scheme (javascript:, data:, …);
            // otherwise assume a bare host and default to https.
            if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
            value = `https://${value}`;
          }
        }
        return { type: l.type as string, label, value };
      })
      .filter((l): l is { type: string; label: string; value: string } => l !== null)
      .slice(0, 5);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...rest,
      ...(sanitizedLinks !== undefined && { profileLinks: sanitizedLinks }),
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
      profileLinks: true,
      lastNameChangeAt: true,
    },
  });
  await invalidateProfileCache(userId);
  return updated;
}

export async function setVerified(userId: string) {
  await findUserOrThrow(userId);
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isVerified: true, verifiedAt: new Date() },
    select: { id: true, isVerified: true, verifiedAt: true, verifiedRole: true },
  });
  await invalidateProfileCache(userId);

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

/// Upsert the user's Subscription row after a validated purchase, so Pro
/// status and reporting have a real record (previously nothing ever wrote it).
export async function recordSubscription(
  userId: string,
  data: { status: string; plan: string; externalId?: string },
) {
  await prisma.subscription.upsert({
    where: { userId },
    create: { userId, ...data },
    update: { ...data },
  });
}

export async function removeVerified(userId: string) {
  await findUserOrThrow(userId);
  // Losing verification also forfeits the private-profile privilege (only
  // verified accounts may be private), so force the profile back to public.
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isVerified: false, verifiedAt: null, isProfilePublic: true },
    select: { id: true, isVerified: true, verifiedAt: true, verifiedRole: true },
  });
  await invalidateProfileCache(userId);

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
      // Unverifying forfeits the private-profile privilege — force public.
      ...(verified ? {} : { isProfilePublic: true }),
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
