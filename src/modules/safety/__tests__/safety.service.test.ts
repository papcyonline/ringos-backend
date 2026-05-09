import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma: any = {
    user: { findUnique: vi.fn() },
    block: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    report: {
      create: vi.fn(),
      count: vi.fn(),
    },
    userModeration: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    conversation: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationParticipant: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  // The transaction handler delegates to a "tx" object that's just the mockPrisma itself.
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  reportUser,
  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlocked,
  recordFlag,
  checkBanStatus,
} from '../safety.service';
import { BadRequestError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
  // Re-install transaction stub after clearAllMocks wipes it.
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
});

// ─── reportUser ──────────────────────────────────────────────────────

describe('reportUser', () => {
  it('rejects self-reports', async () => {
    await expect(
      reportUser('user-1', { reportedId: 'user-1', reason: 'SPAM' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws NotFoundError when reported user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(
      reportUser('user-1', { reportedId: 'ghost', reason: 'SPAM' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('creates report and bumps moderation flag count', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.report.create.mockResolvedValue({ id: 'r-1', reason: 'SPAM', status: 'PENDING' });
    mockPrisma.report.count.mockResolvedValue(1);
    mockPrisma.userModeration.upsert.mockResolvedValue({});

    const res = await reportUser('user-1', { reportedId: 'u-2', reason: 'SPAM' });

    expect(res.report.id).toBe('r-1');
    expect(mockPrisma.report.create).toHaveBeenCalled();
    expect(mockPrisma.userModeration.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u-2' },
    }));
  });

  it('SELF_HARM reports include crisis resources', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.report.create.mockResolvedValue({ id: 'r-1', reason: 'SELF_HARM', status: 'PENDING' });
    mockPrisma.report.count.mockResolvedValue(1);

    const res = await reportUser('user-1', { reportedId: 'u-2', reason: 'SELF_HARM' });

    expect(res.crisisResources).toMatchObject({
      hotline: expect.stringContaining('988'),
      text: expect.stringContaining('741741'),
    });
  });

  it('5+ total reports → PERMANENT_BAN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.report.create.mockResolvedValue({ id: 'r-1', reason: 'SPAM', status: 'PENDING' });
    mockPrisma.report.count.mockResolvedValue(5);
    mockPrisma.userModeration.upsert.mockResolvedValue({});

    await reportUser('user-1', { reportedId: 'u-2', reason: 'SPAM' });

    const calls = mockPrisma.userModeration.upsert.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.create.banStatus).toBe('PERMANENT_BAN');
    expect(lastCall.update.banStatus).toBe('PERMANENT_BAN');
  });

  it('3+ total reports (not yet 5) → TEMP_BAN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.report.create.mockResolvedValue({ id: 'r-1', reason: 'SPAM', status: 'PENDING' });
    mockPrisma.report.count.mockResolvedValue(3);
    mockPrisma.userModeration.upsert.mockResolvedValue({});

    await reportUser('user-1', { reportedId: 'u-2', reason: 'SPAM' });

    const calls = mockPrisma.userModeration.upsert.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.create.banStatus).toBe('TEMP_BAN');
    expect(lastCall.create.banExpiresAt).toBeInstanceOf(Date);
  });

  it('3 reports in 24h (none lifetime threshold) → WARNING', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.report.create.mockResolvedValue({ id: 'r-1', reason: 'SPAM', status: 'PENDING' });
    // total=2, 48h=2, 24h=3 → only the 24h-warn branch fires
    mockPrisma.report.count
      .mockResolvedValueOnce(2)  // total
      .mockResolvedValueOnce(3)  // 24h
      .mockResolvedValueOnce(2); // 48h
    mockPrisma.userModeration.upsert.mockResolvedValue({});

    await reportUser('user-1', { reportedId: 'u-2', reason: 'SPAM' });

    const calls = mockPrisma.userModeration.upsert.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.create.banStatus).toBe('WARNING');
  });
});

// ─── blockUser ───────────────────────────────────────────────────────

describe('blockUser', () => {
  it('rejects self-block', async () => {
    await expect(blockUser('user-1', 'user-1')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws NotFoundError when blocked user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(blockUser('user-1', 'ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('upserts block and ends shared active conversations', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.block.upsert.mockResolvedValue({ id: 'b-1', blockedId: 'u-2', createdAt: new Date() });
    mockPrisma.conversation.findMany.mockResolvedValue([
      { id: 'c-1', status: 'ACTIVE' },
      { id: 'c-2', status: 'ENDED' },
    ]);

    await blockUser('user-1', 'u-2');

    expect(mockPrisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['c-1'] } },
      data: { status: 'ENDED' },
    }));
    expect(mockPrisma.conversationParticipant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        conversationId: { in: ['c-1', 'c-2'] },
        userId: 'user-1',
      }),
      data: expect.objectContaining({ leftAt: expect.any(Date) }),
    }));
  });

  it('skips conversation cleanup when no shared chats', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-2' });
    mockPrisma.block.upsert.mockResolvedValue({ id: 'b-1', blockedId: 'u-2', createdAt: new Date() });
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    await blockUser('user-1', 'u-2');

    expect(mockPrisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.conversationParticipant.updateMany).not.toHaveBeenCalled();
  });
});

// ─── unblockUser ─────────────────────────────────────────────────────

describe('unblockUser', () => {
  it('throws NotFoundError when no block exists', async () => {
    mockPrisma.block.findUnique.mockResolvedValue(null);
    await expect(unblockUser('user-1', 'u-2')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reactivates ended conversations when no reverse-block exists', async () => {
    mockPrisma.block.findUnique
      .mockResolvedValueOnce({ id: 'b-1' })  // initial check
      .mockResolvedValueOnce(null);          // reverse block check inside tx
    mockPrisma.conversation.findMany.mockResolvedValue([{ id: 'c-1' }]);

    await unblockUser('user-1', 'u-2');

    expect(mockPrisma.block.delete).toHaveBeenCalled();
    expect(mockPrisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['c-1'] } },
      data: { status: 'ACTIVE' },
    }));
  });

  it('keeps conversations ended when the other user still blocks back', async () => {
    mockPrisma.block.findUnique
      .mockResolvedValueOnce({ id: 'b-1' })
      .mockResolvedValueOnce({ id: 'b-rev' });

    await unblockUser('user-1', 'u-2');

    expect(mockPrisma.block.delete).toHaveBeenCalled();
    expect(mockPrisma.conversation.updateMany).not.toHaveBeenCalled();
  });
});

// ─── getBlockedUsers ─────────────────────────────────────────────────

describe('getBlockedUsers', () => {
  it('returns flattened {id, blockedUser, createdAt} list', async () => {
    const created = new Date('2026-05-01');
    mockPrisma.block.findMany.mockResolvedValue([
      {
        id: 'b-1',
        createdAt: created,
        blocked: { id: 'u-2', displayName: 'Bob', avatarUrl: null, bio: null, isVerified: false },
      },
    ]);

    const res = await getBlockedUsers('user-1');

    expect(res).toEqual([
      {
        id: 'b-1',
        createdAt: created,
        blockedUser: { id: 'u-2', displayName: 'Bob', avatarUrl: null, bio: null, isVerified: false },
      },
    ]);
  });
});

// ─── isBlocked ───────────────────────────────────────────────────────

describe('isBlocked', () => {
  it('returns true when either direction is blocked', async () => {
    mockPrisma.block.findFirst.mockResolvedValue({ id: 'b-1' });
    expect(await isBlocked('a', 'b')).toBe(true);
  });

  it('returns false when neither direction is blocked', async () => {
    mockPrisma.block.findFirst.mockResolvedValue(null);
    expect(await isBlocked('a', 'b')).toBe(false);
  });
});

// ─── recordFlag ──────────────────────────────────────────────────────

describe('recordFlag', () => {
  it('upserts userModeration with flagCount=1 (create) / increment (update)', async () => {
    mockPrisma.userModeration.upsert.mockResolvedValue({});

    await recordFlag('u-2');

    expect(mockPrisma.userModeration.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u-2' },
      create: expect.objectContaining({ flagCount: 1 }),
      update: expect.objectContaining({ flagCount: { increment: 1 } }),
    }));
  });
});

// ─── checkBanStatus ──────────────────────────────────────────────────

describe('checkBanStatus', () => {
  it('throws NotFoundError when user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(checkBanStatus('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns NONE when no moderation record', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.userModeration.findUnique.mockResolvedValue(null);

    const res = await checkBanStatus('u-1');

    expect(res).toEqual({ banned: false, status: 'NONE' });
  });

  it('returns banned=true with expiresAt for active TEMP_BAN', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.userModeration.findUnique.mockResolvedValue({
      banStatus: 'TEMP_BAN',
      banExpiresAt: future,
    });

    const res = await checkBanStatus('u-1');

    expect(res).toEqual({ banned: true, status: 'TEMP_BAN', expiresAt: future });
  });

  it('expires lapsed TEMP_BAN and resets to NONE', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.userModeration.findUnique.mockResolvedValue({
      banStatus: 'TEMP_BAN',
      banExpiresAt: past,
    });
    mockPrisma.userModeration.update.mockResolvedValue({});

    const res = await checkBanStatus('u-1');

    expect(res).toEqual({ banned: false, status: 'NONE' });
    expect(mockPrisma.userModeration.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ banStatus: 'NONE', banExpiresAt: null, flagCount: 0 }),
    }));
  });

  it('PERMANENT_BAN returns banned=true', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.userModeration.findUnique.mockResolvedValue({
      banStatus: 'PERMANENT_BAN',
      banExpiresAt: null,
    });

    const res = await checkBanStatus('u-1');

    expect(res.banned).toBe(true);
    expect(res.status).toBe('PERMANENT_BAN');
    expect((res as any).expiresAt).toBeUndefined();
  });

  it('WARNING does not count as banned', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.userModeration.findUnique.mockResolvedValue({
      banStatus: 'WARNING',
      banExpiresAt: null,
    });

    const res = await checkBanStatus('u-1');

    expect(res.banned).toBe(false);
    expect(res.status).toBe('WARNING');
  });
});
