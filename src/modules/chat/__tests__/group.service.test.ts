import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const tx = vi.fn(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  const mockPrisma: any = {
    conversation: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    conversationParticipant: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    postMedia: {
      findMany: vi.fn(),
    },
    $transaction: tx,
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../shared/usage.service', () => ({
  isPro: vi.fn().mockResolvedValue(false),
}));
// group.service imports notifyAddedToGroup from notification.service, which
// eagerly pulls in config/socket → config/env (loadEnv calls process.exit on
// missing test env). Mock it so the import chain stays inert in tests.
vi.mock('../../notification/notification.service', () => ({
  notifyAddedToGroup: vi.fn().mockResolvedValue(undefined),
}));

import {
  createGroup,
  updateGroup,
  addMembers,
  removeMember,
  deleteGroup,
  joinGroup,
  toggleGroupVerified,
  updateGroupCallSettings,
  makeAdmin,
  checkNameAvailable,
  demoteAdmin,
  generateInviteCode,
  revokeInviteCode,
  joinViaInviteCode,
  updateGroupAdminSettings,
  banMember,
  unbanMember,
} from '../group.service';
import { ForbiddenError, NotFoundError, ConflictError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── createGroup ─────────────────────────────────────────────────────

describe('createGroup', () => {
  it('rejects unverified user trying to create a 2nd group', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false });
    mockPrisma.conversation.count.mockResolvedValue(1);

    await expect(createGroup('user-1', 'My Group', [])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects free user trying to create a 2nd channel', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    mockPrisma.conversation.count.mockResolvedValue(1);

    await expect(createGroup('user-1', 'My Channel', [], undefined, undefined, undefined, true))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when name already exists for active group', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    mockPrisma.conversation.count.mockResolvedValue(0);
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(createGroup('user-1', 'Taken', [])).rejects.toBeInstanceOf(ConflictError);
  });

  it('auto-verifies group created by verified user, dedupes member list', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    mockPrisma.conversation.count.mockResolvedValue(0);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: 'g-1' });

    await createGroup('user-1', 'Squad', ['u-2', 'u-2', 'user-1', 'u-3']);

    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isVerified: true,
        participants: {
          create: [
            { userId: 'user-1', role: 'ADMIN' },
            { userId: 'u-2', role: 'MEMBER' },
            { userId: 'u-3', role: 'MEMBER' },
          ],
        },
      }),
    }));
  });

  it('channels default to admins-only-messages and isChannel=true', async () => {
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(true);
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false });
    mockPrisma.conversation.count.mockResolvedValue(0);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: 'c-1' });

    await createGroup('user-1', 'News', [], undefined, undefined, undefined, true);

    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isChannel: true,
        adminsOnlyMessages: true,
      }),
    }));
  });
});

// ─── updateGroup ─────────────────────────────────────────────────────

describe('updateGroup', () => {
  it('rejects non-participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(updateGroup('c1', 'user-1', { name: 'New' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects member when adminsOnlyEditInfo is true', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER', leftAt: null });
    mockPrisma.conversation.findUnique.mockResolvedValue({ adminsOnlyEditInfo: true });

    await expect(updateGroup('c1', 'user-1', { name: 'New' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('member can edit when adminsOnlyEditInfo is false', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER', leftAt: null });
    mockPrisma.conversation.findUnique
      .mockResolvedValueOnce({ adminsOnlyEditInfo: false })
      .mockResolvedValueOnce({ status: 'ACTIVE' });
    mockPrisma.conversation.update.mockResolvedValue({ id: 'c1' });

    await updateGroup('c1', 'user-1', { name: 'New' });

    expect(mockPrisma.conversation.update).toHaveBeenCalled();
  });

  it('only writes provided keys (omits undefined)', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN', leftAt: null });
    mockPrisma.conversation.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    mockPrisma.conversation.update.mockResolvedValue({ id: 'c1' });

    await updateGroup('c1', 'user-1', { name: 'New' });

    const data = (mockPrisma.conversation.update.mock.calls[0][0] as any).data;
    expect(data).toEqual({ name: 'New' });
  });
});

// ─── addMembers ──────────────────────────────────────────────────────

describe('addMembers', () => {
  it('rejects non-participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(addMembers('c1', 'admin-1', ['u-2'])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects member when adminsOnlyAddMembers is true', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ adminsOnlyAddMembers: true });

    await expect(addMembers('c1', 'user-1', ['u-2'])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejoins members who previously left and adds new ones', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'u-2', leftAt: new Date() },
    ]);
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: 'c1' });

    await addMembers('c1', 'admin-1', ['u-2', 'u-3']);

    expect(mockPrisma.conversationParticipant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: 'c1', userId: { in: ['u-2'] } },
      data: expect.objectContaining({ leftAt: null }),
    }));
    expect(mockPrisma.conversationParticipant.createMany).toHaveBeenCalledWith({
      data: [{ conversationId: 'c1', userId: 'u-3', role: 'MEMBER' }],
    });
  });
});

// ─── removeMember ────────────────────────────────────────────────────

describe('removeMember', () => {
  it('rejects when requester is not a participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(removeMember('c1', 'user-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects member trying to remove someone else', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValueOnce({ role: 'MEMBER' });
    await expect(removeMember('c1', 'user-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('allows self-leave', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'MEMBER' })
      .mockResolvedValueOnce({ id: 'p1', leftAt: null });

    await removeMember('c1', 'user-1', 'user-1');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ leftAt: expect.any(Date) }),
    }));
  });

  it('admin can remove another member', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ id: 'p2', leftAt: null });

    await removeMember('c1', 'admin-1', 'u-2');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalled();
  });

  it('throws NotFoundError when target not in group', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce(null);

    await expect(removeMember('c1', 'admin-1', 'ghost')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─── deleteGroup ─────────────────────────────────────────────────────

describe('deleteGroup', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(deleteGroup('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('hard-deletes channel and queues media cleanup', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', isChannel: true, avatarUrl: null, bannerUrl: null,
    });
    mockPrisma.postMedia.findMany.mockResolvedValue([]);

    await deleteGroup('c1', 'admin-1');

    expect(mockPrisma.conversation.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });

  it('soft-deletes group (status ENDED) preserving history', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', isChannel: false,
    });

    await deleteGroup('c1', 'admin-1');

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.conversation.delete).not.toHaveBeenCalled();
  });
});

// ─── joinGroup ───────────────────────────────────────────────────────

describe('joinGroup', () => {
  it('rejects when group is private', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', status: 'ACTIVE', isPublic: false,
    });

    await expect(joinGroup('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects banned user', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', status: 'ACTIVE', isPublic: true,
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ bannedAt: new Date() });

    await expect(joinGroup('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('upserts participant for public active group', async () => {
    mockPrisma.conversation.findUnique
      .mockResolvedValueOnce({ id: 'c1', type: 'GROUP', status: 'ACTIVE', isPublic: true })
      .mockResolvedValueOnce({ id: 'c1' });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await joinGroup('c1', 'user-1');

    expect(mockPrisma.conversationParticipant.upsert).toHaveBeenCalled();
  });

  it('rejects ended group', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', status: 'ENDED', isPublic: true,
    });

    await expect(joinGroup('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── toggleGroupVerified ─────────────────────────────────────────────

describe('toggleGroupVerified', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(toggleGroupVerified('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects unverified admin trying to enable verification', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', isVerified: false,
    });
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false });

    await expect(toggleGroupVerified('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('verified admin can turn verification on', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', isVerified: false,
    });
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    mockPrisma.conversation.update.mockResolvedValue({ isVerified: true });

    await toggleGroupVerified('c1', 'user-1');

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isVerified: true },
    }));
  });

  it('un-verifying does not require admin to be verified', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', isVerified: true,
    });
    mockPrisma.conversation.update.mockResolvedValue({ isVerified: false });

    await toggleGroupVerified('c1', 'user-1');

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isVerified: false },
    }));
  });
});

// ─── updateGroupCallSettings ─────────────────────────────────────────

describe('updateGroupCallSettings', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(updateGroupCallSettings('c1', 'user-1', { callsEnabled: false }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admin can flip both flags', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: 'c1', type: 'GROUP' });
    mockPrisma.conversation.update.mockResolvedValue({ id: 'c1' });

    await updateGroupCallSettings('c1', 'admin-1', { callsEnabled: false, videoEnabled: true });

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { callsEnabled: false, videoEnabled: true },
    }));
  });
});

// ─── makeAdmin / demoteAdmin ─────────────────────────────────────────

describe('makeAdmin', () => {
  it('rejects non-admin requester', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(makeAdmin('c1', 'user-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when target is already admin', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ id: 'p2', leftAt: null, role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: 'c1', type: 'GROUP' });

    await expect(makeAdmin('c1', 'admin-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('promotes member to admin', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ id: 'p2', leftAt: null, role: 'MEMBER' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: 'c1', type: 'GROUP' });
    mockPrisma.conversation.findUniqueOrThrow.mockResolvedValue({ id: 'c1' });

    await makeAdmin('c1', 'admin-1', 'u-2');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith({
      where: { id: 'p2' },
      data: { role: 'ADMIN' },
    });
  });
});

describe('demoteAdmin', () => {
  it('rejects self-demotion', async () => {
    await expect(demoteAdmin('c1', 'user-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects non-admin requester', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(demoteAdmin('c1', 'user-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when target is not an admin', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ id: 'p2', leftAt: null, role: 'MEMBER' });

    await expect(demoteAdmin('c1', 'admin-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('demotes admin to member', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ id: 'p2', leftAt: null, role: 'ADMIN' });

    await demoteAdmin('c1', 'admin-1', 'u-2');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith({
      where: { id: 'p2' },
      data: { role: 'MEMBER' },
    });
  });
});

// ─── checkNameAvailable ──────────────────────────────────────────────

describe('checkNameAvailable', () => {
  it('returns true when no match', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    expect(await checkNameAvailable('Free', false)).toBe(true);
  });

  it('returns false when name exists', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'c1' });
    expect(await checkNameAvailable('Taken', true)).toBe(false);
  });
});

// ─── invite codes ────────────────────────────────────────────────────

describe('invite codes', () => {
  it('generateInviteCode requires admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(generateInviteCode('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('generateInviteCode returns a base64url token', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.update.mockResolvedValue({});

    const res = await generateInviteCode('c1', 'admin-1');

    expect(res.inviteCode).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('revokeInviteCode requires admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(revokeInviteCode('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('revokeInviteCode clears the code', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.update.mockResolvedValue({});

    await revokeInviteCode('c1', 'admin-1');

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { inviteCode: null },
    }));
  });

  it('joinViaInviteCode rejects bad code', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    await expect(joinViaInviteCode('XXX', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('joinViaInviteCode rejects banned user', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', status: 'ACTIVE',
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ bannedAt: new Date() });

    await expect(joinViaInviteCode('CODE', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('joinViaInviteCode upserts participant on success', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', status: 'ACTIVE',
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await joinViaInviteCode('CODE', 'user-1');

    expect(mockPrisma.conversationParticipant.upsert).toHaveBeenCalled();
  });
});

// ─── updateGroupAdminSettings ────────────────────────────────────────

describe('updateGroupAdminSettings', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(updateGroupAdminSettings('c1', 'user-1', { adminsOnlyMessages: true }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('writes only provided keys', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.update.mockResolvedValue({});

    await updateGroupAdminSettings('c1', 'admin-1', { adminsOnlyMessages: true });

    const data = (mockPrisma.conversation.update.mock.calls[0][0] as any).data;
    expect(data).toEqual({ adminsOnlyMessages: true });
  });
});

// ─── ban / unban ─────────────────────────────────────────────────────

describe('banMember', () => {
  it('rejects banning an admin', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ role: 'ADMIN' });

    await expect(banMember('c1', 'admin-1', 'u-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('marks user as banned and sets leftAt', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({ role: 'MEMBER' });

    await banMember('c1', 'admin-1', 'u-2');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        bannedAt: expect.any(Date),
        leftAt: expect.any(Date),
      }),
    }));
  });
});

describe('unbanMember', () => {
  it('clears bannedAt', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });

    await unbanMember('c1', 'admin-1', 'u-2');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { bannedAt: null },
    }));
  });
});
