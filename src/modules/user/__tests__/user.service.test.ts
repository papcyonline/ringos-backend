import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma: any = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    userPreference: {
      upsert: vi.fn(),
    },
    follow: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    like: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    block: {
      findMany: vi.fn(),
    },
    conversation: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationParticipant: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    postMedia: {
      findMany: vi.fn(),
    },
    storySlide: {
      findMany: vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../safety/safety.service', () => ({
  isBlocked: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../shared/usage.service', () => ({
  isPro: vi.fn().mockResolvedValue(false),
  getLimits: vi.fn().mockResolvedValue({ bioLength: 200, storyUploadMB: 50, pinnedChats: 3 }),
}));
vi.mock('../../auth/auth.service', () => ({
  checkUsernameAvailable: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../../shared/cloudinary.service', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

import {
  getProfile,
  getUserById,
  updateAvailability,
  stopAvailability,
  expireAvailabilities,
  uploadAvatar,
  setOnline,
  setOffline,
  updatePreference,
  updatePrivacy,
  updateProfile,
  setPhoneHash,
  removePhoneHash,
  syncContacts,
  adminSetVerified,
  deleteAccount,
  listUsers,
  setVerified,
  removeVerified,
} from '../user.service';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';

function baseUser(over: Partial<any> = {}) {
  return {
    id: 'user-1',
    displayName: 'Alice',
    avatarUrl: null,
    bio: null,
    profession: null,
    gender: null,
    location: null,
    isVerified: false,
    isProfilePublic: true,
    hideOnlineStatus: false,
    hideReadReceipts: false,
    lastNameChangeAt: null,
    moderation: { banStatus: 'NONE', banExpiresAt: null, flagCount: 0 },
    preference: { mood: null, language: 'en', timezone: 'UTC', topics: [] },
    _count: { followsReceived: 5, followsInitiated: 7, likesReceived: 2 },
    isOnline: true,
    lastSeenAt: new Date('2026-05-01T00:00:00Z'),
    availableFor: ['text'],
    availableUntil: null,
    status: 'available',
    availabilityNote: null,
    verifiedRole: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getProfile ──────────────────────────────────────────────────────

describe('getProfile', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(getProfile('u-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('flattens moderation and follow counts onto returned user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());

    const res = await getProfile('user-1');

    expect(res.banStatus).toBe('NONE');
    expect(res.followerCount).toBe(5);
    expect(res.followingCount).toBe(7);
  });
});

// ─── getUserById ─────────────────────────────────────────────────────

describe('getUserById', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(getUserById('u-x', 'u1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError if mutually blocked (only between different users)', async () => {
    const safety = await import('../../safety/safety.service');
    (safety.isBlocked as any).mockResolvedValueOnce(true);
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());

    await expect(getUserById('user-1', 'viewer')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('hides bio/location/profession when profile is private', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({
      isProfilePublic: false,
      bio: 'secret',
      profession: 'spy',
      location: 'unknown',
      availabilityNote: 'busy',
    }));
    mockPrisma.follow.findFirst.mockResolvedValue(null);
    mockPrisma.like.findFirst.mockResolvedValue(null);

    const res = await getUserById('user-1', 'viewer');

    expect(res.bio).toBeNull();
    expect(res.profession).toBeNull();
    expect(res.location).toBeNull();
    expect(res.availabilityNote).toBeNull();
  });

  it('hides isOnline / lastSeenAt when hideOnlineStatus is true (different user)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({
      hideOnlineStatus: true,
      isOnline: true,
      lastSeenAt: new Date(),
    }));
    mockPrisma.follow.findFirst.mockResolvedValue(null);
    mockPrisma.like.findFirst.mockResolvedValue(null);

    const res = await getUserById('user-1', 'viewer');
    expect(res.isOnline).toBe(false);
    expect(res.lastSeenAt).toBeNull();
  });

  it('reflects isFollowedByMe and isLikedByMe based on records', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.follow.findFirst.mockResolvedValue({ id: 'f1' });
    mockPrisma.like.findFirst.mockResolvedValue(null);

    const res = await getUserById('user-1', 'viewer');
    expect(res.isFollowedByMe).toBe(true);
    expect(res.isLikedByMe).toBe(false);
  });
});

// ─── availability ────────────────────────────────────────────────────

describe('updateAvailability', () => {
  it('writes parsed availableUntil from ISO string', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1' });

    await updateAvailability('user-1', {
      availableFor: ['voice'],
      availabilityNote: 'open to chat',
      status: 'busy',
      availableUntil: '2026-05-08T15:00:00Z',
    } as any);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        availableFor: ['voice'],
        availabilityNote: 'open to chat',
        status: 'busy',
        availableUntil: new Date('2026-05-08T15:00:00Z'),
      }),
    }));
  });

  it('defaults status to "available" and note to null when omitted', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1' });

    await updateAvailability('user-1', { availableFor: ['text'] } as any);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'available',
        availabilityNote: null,
        availableUntil: null,
      }),
    }));
  });
});

describe('stopAvailability', () => {
  it('resets to text/available/null', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1' });

    await stopAvailability('user-1');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        availableFor: ['text'],
        status: 'available',
        availabilityNote: null,
        availableUntil: null,
      }),
    }));
  });
});

describe('expireAvailabilities', () => {
  it('returns [] and skips updateMany when no expired users', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    const res = await expireAvailabilities();

    expect(res).toEqual([]);
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('bulk-resets users whose availableUntil is in the past', async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 2 });

    const res = await expireAvailabilities();

    expect(res).toEqual(['u1', 'u2']);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1', 'u2'] } },
      data: expect.objectContaining({
        availableFor: ['text'],
        status: 'available',
        availableUntil: null,
      }),
    });
  });
});

// ─── basic setters ───────────────────────────────────────────────────

describe('uploadAvatar / setOnline / setOffline', () => {
  it('uploadAvatar writes avatarUrl', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', avatarUrl: 'a.jpg' });

    await uploadAvatar('user-1', 'a.jpg');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { avatarUrl: 'a.jpg' },
    }));
  });

  it('setOnline flips isOnline=true via updateMany', async () => {
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    await setOnline('user-1');
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isOnline: true },
    });
  });

  it('setOffline flips isOnline=false and stamps lastSeenAt via updateMany', async () => {
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    await setOffline('user-1');
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isOnline: false,
        lastSeenAt: expect.any(Date),
      }),
    }));
  });

  it('setOffline is a no-op (does not throw) when the user no longer exists', async () => {
    // updateMany returns count:0 for a deleted account / stale socket — the
    // disconnect handler must never throw (regression for P2025).
    mockPrisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(setOffline('ghost')).resolves.toBeUndefined();
  });
});

// ─── updatePreference ────────────────────────────────────────────────

describe('updatePreference', () => {
  it('upserts the user preference row', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.userPreference.upsert.mockResolvedValue({});

    await updatePreference('user-1', { language: 'fr' } as any);

    expect(mockPrisma.userPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
    }));
  });
});

// ─── updatePrivacy ───────────────────────────────────────────────────

describe('updatePrivacy', () => {
  it('rejects hideReadReceipts=true for non-Pro users', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(false);

    await expect(updatePrivacy('user-1', { hideReadReceipts: true } as any)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('allows Pro users to enable hideReadReceipts', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(true);
    mockPrisma.user.update.mockResolvedValue({});

    await updatePrivacy('user-1', { hideReadReceipts: true } as any);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { hideReadReceipts: true },
    }));
  });

  it('only writes fields that were provided', async () => {
    // isProfilePublic=false requires a verified account (privacy guard
    // added in feat(privacy)); seed the mock user with isVerified=true.
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ isVerified: true }));
    mockPrisma.user.update.mockResolvedValue({});

    await updatePrivacy('user-1', { isProfilePublic: false } as any);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isProfilePublic: false },
    }));
  });
});

// ─── updateProfile ───────────────────────────────────────────────────

describe('updateProfile', () => {
  it('rejects bio that exceeds free-tier limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    const longBio = 'a'.repeat(201);

    await expect(updateProfile('user-1', { bio: longBio } as any)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects display name change inside cooldown window', async () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ lastNameChangeAt: recent }));

    await expect(updateProfile('user-1', { displayName: 'NewName' } as any)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects display name change when username is taken', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ lastNameChangeAt: null }));
    const auth = await import('../../auth/auth.service');
    (auth.checkUsernameAvailable as any).mockResolvedValueOnce(false);

    await expect(updateProfile('user-1', { displayName: 'Taken' } as any)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects unverified user changing location', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ isVerified: false, location: 'NYC' }));

    await expect(updateProfile('user-1', { location: 'LA' } as any)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('verified user can change location', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ isVerified: true, location: 'NYC' }));
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1' });

    await updateProfile('user-1', { location: 'LA' } as any);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ location: 'LA' }),
    }));
  });

  it('successful displayName change stamps lastNameChangeAt', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ displayName: 'Old', lastNameChangeAt: null }));
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1' });

    await updateProfile('user-1', { displayName: 'New' } as any);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        displayName: 'New',
        lastNameChangeAt: expect.any(Date),
      }),
    }));
  });
});

// ─── adminSetVerified ────────────────────────────────────────────────

describe('adminSetVerified', () => {
  it('throws NotFoundError when user not found', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await expect(adminSetVerified('nope', true)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('verifies user and cascades to admin channels', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', isVerified: true });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ conversationId: 'c1' }, { conversationId: 'c2' }]);
    mockPrisma.conversation.updateMany.mockResolvedValue({ count: 2 });

    await adminSetVerified('user-1', true, 'Brand');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isVerified: true,
        verifiedRole: 'Brand',
      }),
    }));
    expect(mockPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
      data: { isVerified: true },
    });
  });

  it('un-verifying clears verifiedAt and verifiedRole', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    await adminSetVerified('user-1', false);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isVerified: false, verifiedAt: null, verifiedRole: null },
    }));
  });
});

// ─── deleteAccount ───────────────────────────────────────────────────

describe('deleteAccount', () => {
  it('throws NotFoundError when user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(deleteAccount('u-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes user and ends sole-admin channels', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@x.com', displayName: 'Alice', avatarUrl: null });
    mockPrisma.postMedia.findMany.mockResolvedValue([]);
    mockPrisma.storySlide.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', avatarUrl: null, bannerUrl: null },
    ]);
    mockPrisma.user.delete.mockResolvedValue({});
    mockPrisma.conversationParticipant.count.mockResolvedValue(0);
    mockPrisma.conversation.update.mockResolvedValue({});

    const res = await deleteAccount('user-1');

    expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c1' },
      data: { status: 'ENDED' },
    }));
    expect(res).toEqual({ email: 'a@x.com', displayName: 'Alice' });
  });

  it('keeps channels alive when other admins remain', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@x.com', displayName: 'Alice', avatarUrl: null });
    mockPrisma.postMedia.findMany.mockResolvedValue([]);
    mockPrisma.storySlide.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', avatarUrl: null, bannerUrl: null },
    ]);
    mockPrisma.user.delete.mockResolvedValue({});
    mockPrisma.conversationParticipant.count.mockResolvedValue(2);

    await deleteAccount('user-1');

    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });
});

// ─── phone hash + contact sync ───────────────────────────────────────

describe('setPhoneHash', () => {
  it('rejects when hash belongs to another user', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'other' });
    await expect(setPhoneHash('user-1', 'hash')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('writes hash when free', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', phoneLookup: 'hash' });

    const res = await setPhoneHash('user-1', 'hash');

    expect(res.phoneLookup).toBe('hash');
  });
});

describe('removePhoneHash', () => {
  it('clears phoneLookup', async () => {
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', phoneLookup: null });
    await removePhoneHash('user-1');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { phoneLookup: null },
    }));
  });
});

describe('syncContacts', () => {
  it('excludes self and blocked users from candidate set', async () => {
    const spotlight = await import('../../spotlight/spotlight.service');
    (spotlight.getBlockedUserIds as any).mockResolvedValueOnce(new Set(['blocked-1']));
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u2' }]);

    await syncContacts('user-1', ['h1', 'h2']);

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        phoneLookup: { in: ['h1', 'h2'] },
        id: { notIn: ['user-1', 'blocked-1'] },
      }),
    }));
  });
});

describe('listUsers', () => {
  it('excludes blocked users + current user, paginates results', async () => {
    mockPrisma.block.findMany.mockResolvedValue([
      { blockerId: 'user-1', blockedId: 'blocked-1' },
      { blockerId: 'blocked-2', blockedId: 'user-1' },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 'u-2', displayName: 'Bob', avatarUrl: null, bio: 'hi',
        profession: null, gender: null, location: 'NYC', status: 'available',
        availabilityNote: null, isOnline: true, lastSeenAt: new Date(),
        availableFor: ['text'], availableUntil: null, isVerified: false,
        verifiedRole: null, isProfilePublic: true, hideOnlineStatus: false,
        moderation: { flagCount: 0 },
        preference: { language: 'en' },
        _count: { followsReceived: 5, likesReceived: 2 },
      },
    ]);
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.follow.findMany.mockResolvedValue([{ followingId: 'u-2' }]);
    mockPrisma.like.findMany.mockResolvedValue([]);

    const res = await listUsers('user-1', 1, 10);

    expect(res.users).toHaveLength(1);
    expect(res.users[0].isFollowedByMe).toBe(true);
    expect(res.users[0].isLikedByMe).toBe(false);
    expect(res.total).toBe(1);
  });

  it('keeps the onboarding gate but does NOT gate visibility on bio', async () => {
    // Regression guard: a bio requirement used to hide every onboarded user
    // with a NULL/empty bio. Visibility must depend only on isAnonymous +
    // a non-empty displayName — never on bio. Unique viewer/limit so the
    // in-memory list cache can't serve a prior test's result.
    mockPrisma.block.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.like.findMany.mockResolvedValue([]);

    await listUsers('bio-fix-viewer', 1, 9);

    const whereArg = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(whereArg.isAnonymous).toBe(false);
    expect(whereArg.displayName).toEqual({ not: '' });
    expect(whereArg.bio).toBeUndefined();
  });

  it('hides bio/profession/location for private profiles', async () => {
    mockPrisma.block.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 'u-2', displayName: 'Bob', avatarUrl: null,
        bio: 'private', profession: 'p', location: 'NYC',
        gender: null, status: 'available', availabilityNote: 'note',
        isOnline: true, lastSeenAt: new Date(),
        availableFor: ['text'], availableUntil: null, isVerified: false,
        verifiedRole: null, isProfilePublic: false, hideOnlineStatus: false,
        moderation: { flagCount: 0 },
        preference: null,
        _count: { followsReceived: 0, likesReceived: 0 },
      },
    ]);
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.like.findMany.mockResolvedValue([]);

    const res = await listUsers('user-1');
    expect(res.users[0].bio).toBeNull();
    expect(res.users[0].profession).toBeNull();
    expect(res.users[0].location).toBeNull();
    expect(res.users[0].language).toBe('en');
  });

  it('hides isOnline/lastSeenAt when hideOnlineStatus=true', async () => {
    mockPrisma.block.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 'u-2', displayName: 'Bob', avatarUrl: null,
        bio: 'hi', profession: null, location: null, gender: null,
        status: 'available', availabilityNote: null,
        isOnline: true, lastSeenAt: new Date(),
        availableFor: ['text'], availableUntil: null, isVerified: false,
        verifiedRole: null, isProfilePublic: true, hideOnlineStatus: true,
        moderation: { flagCount: 0 },
        preference: { language: 'en' },
        _count: { followsReceived: 0, likesReceived: 0 },
      },
    ]);
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.like.findMany.mockResolvedValue([]);

    const res = await listUsers('user-1');
    expect(res.users[0].isOnline).toBe(false);
    expect(res.users[0].lastSeenAt).toBeNull();
  });
});

describe('setVerified / removeVerified', () => {
  it('setVerified flips isVerified=true', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', isVerified: true });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);
    const res = await setVerified('user-1');
    expect(res.isVerified).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isVerified: true }),
    }));
  });

  it('removeVerified flips isVerified=false', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', isVerified: false });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);
    const res = await removeVerified('user-1');
    expect(res.isVerified).toBe(false);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isVerified: false, verifiedAt: null }),
    }));
  });
});
