import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const tx = vi.fn(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  const mockPrisma: any = {
    conversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationParticipant: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    callLog: {
      findMany: vi.fn(),
    },
    webVisitor: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: tx,
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../shared/cloudinary.service', () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../safety/safety.service', () => ({
  isBlocked: vi.fn().mockResolvedValue(false),
  blockUser: vi.fn().mockResolvedValue({ id: 'b-1' }),
}));
vi.mock('../streak.service', () => ({
  tryRecordMessageForStreak: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../shared/usage.service', () => ({
  getLimits: vi.fn().mockResolvedValue({ pinnedChats: 3, bioLength: 200, storyUploadMB: 50 }),
  isPro: vi.fn().mockResolvedValue(false),
}));
vi.mock('open-graph-scraper', () => ({ default: vi.fn() }));

import {
  getConversation,
  getConversations,
  getOrCreateChannelDM,
  getChannelInbox,
  getChannelInboxUnreadCount,
  blockChannelSubscriber,
  deleteChannelDM,
} from '../chat.service';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getConversation ─────────────────────────────────────────────────

describe('getConversation', () => {
  it('allows non-participant for GROUP conversations (publicly discoverable)', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', participants: [
        { userId: 'someone', user: { hideOnlineStatus: false } },
      ],
    });

    const res = await getConversation('c1', 'user-1');

    expect(res).toBeDefined();
  });

  it('hides online status for participants who opted out', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c1', type: 'GROUP', participants: [
        { userId: 'u-2', user: { hideOnlineStatus: true, isOnline: true, lastSeenAt: new Date() } },
        { userId: 'u-3', user: { hideOnlineStatus: false, isOnline: true, lastSeenAt: new Date() } },
      ],
    });

    const res = await getConversation('c1', 'user-1');

    expect(res.participants[0].user.isOnline).toBe(false);
    expect(res.participants[0].user.lastSeenAt).toBeNull();
    expect(res.participants[1].user.isOnline).toBe(true);
  });
});

// ─── getConversations ────────────────────────────────────────────────

describe('getConversations', () => {
  it('returns empty list for user with no conversations', async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.message.groupBy.mockResolvedValue([]);
    mockPrisma.callLog.findMany.mockResolvedValue([]);

    const res = await getConversations('user-1');

    expect(res).toEqual([]);
  });

  it('attaches lastMessage with computed status, unreadCount, and missed call info', async () => {
    const lastReadAt = new Date('2026-05-01T00:00:00Z');
    const msgCreatedAt = new Date('2026-05-01T01:00:00Z');
    mockPrisma.conversation.findMany.mockResolvedValue([
      {
        id: 'c-1',
        type: 'HUMAN_MATCHED',
        status: 'ACTIVE',
        participants: [
          { userId: 'user-1', lastReadAt, lastDeliveredAt: null },
          { userId: 'u-2', lastReadAt: null, lastDeliveredAt: null },
        ],
        messages: [
          { id: 'm-1', content: 'hi', senderId: 'u-2', createdAt: msgCreatedAt, isSystem: false, deletedAt: null, imageUrl: null, audioUrl: null },
        ],
      },
    ]);
    mockPrisma.message.groupBy.mockResolvedValue([{ conversationId: 'c-1', _count: { id: 5 } }]);
    mockPrisma.message.findMany.mockResolvedValue([
      { conversationId: 'c-1', createdAt: msgCreatedAt },
    ]);
    mockPrisma.callLog.findMany.mockResolvedValue([
      { conversationId: 'c-1', callType: 'VOICE', startedAt: new Date(), status: 'MISSED', durationSecs: 0, initiatorId: 'u-2', initiator: { displayName: 'Bob' } },
    ]);

    const res = await getConversations('user-1');

    expect(res).toHaveLength(1);
    expect(res[0].lastMessage).toBeTruthy();
    expect(res[0].lastMissedCall).toMatchObject({ callType: 'VOICE' });
  });
});

// ─── getOrCreateChannelDM ────────────────────────────────────────────

describe('getOrCreateChannelDM', () => {
  it('throws when channel missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    await expect(getOrCreateChannelDM('c-x', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when channel is not a channel', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      isChannel: false, status: 'ACTIVE',
    });
    await expect(getOrCreateChannelDM('c-1', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when no admin found', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c-1', isChannel: true, status: 'ACTIVE', name: 'Chan', avatarUrl: null,
    });
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue(null);

    await expect(getOrCreateChannelDM('c-1', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects subscriber=admin (cannot DM your own channel)', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c-1', isChannel: true, status: 'ACTIVE', name: 'Chan', avatarUrl: null,
    });
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'u-1' });

    await expect(getOrCreateChannelDM('c-1', 'u-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when blocked', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c-1', isChannel: true, status: 'ACTIVE', name: 'Chan', avatarUrl: null,
    });
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'admin-1' });
    const safety = await import('../../safety/safety.service');
    (safety.isBlocked as any).mockResolvedValueOnce(true);

    await expect(getOrCreateChannelDM('c-1', 'u-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns existing channel DM when present', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c-1', isChannel: true, status: 'ACTIVE', name: 'Chan', avatarUrl: null,
    });
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'admin-1' });
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'existing-dm' });

    const res = await getOrCreateChannelDM('c-1', 'u-1');

    expect(res.id).toBe('existing-dm');
    expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
  });

  it('creates new channel DM when none exists', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'c-1', isChannel: true, status: 'ACTIVE', name: 'Chan', avatarUrl: 'a.jpg',
    });
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'admin-1' });
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: 'new-dm' });

    await getOrCreateChannelDM('c-1', 'subscriber-1');

    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        channelSourceId: 'c-1',
        name: 'Chan',
        avatarUrl: 'a.jpg',
      }),
    }));
  });
});

// ─── getChannelInbox ─────────────────────────────────────────────────

describe('getChannelInbox', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(getChannelInbox('c-1', 'u-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns inbox items with unread counts when admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findMany.mockResolvedValue([
      {
        id: 'dm-1',
        participants: [{ userId: 'u-1', lastReadAt: null }],
        messages: [{ id: 'm', content: 'hi', senderId: 'u-2', createdAt: new Date() }],
      },
    ]);
    mockPrisma.message.groupBy.mockResolvedValue([{ conversationId: 'dm-1', _count: { id: 3 } }]);

    const res = await getChannelInbox('c-1', 'u-1');

    expect(res.items[0]).toMatchObject({ id: 'dm-1', unreadCount: 3 });
    expect(res.hasMore).toBe(false);
  });

  it('uses cursor for pagination', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ updatedAt: new Date() });
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    await getChannelInbox('c-1', 'u-1', 'dm-cursor');

    const where = (mockPrisma.conversation.findMany.mock.calls[0][0] as any).where;
    expect(where.updatedAt).toEqual({ lt: expect.any(Date) });
  });
});

// ─── getChannelInboxUnreadCount ──────────────────────────────────────

describe('getChannelInboxUnreadCount', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(getChannelInboxUnreadCount('c-1', 'u-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns 0 when no DMs exist', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    expect(await getChannelInboxUnreadCount('c-1', 'admin-1')).toEqual({ count: 0 });
  });

  it('counts unread across all DMs without lastReadAt', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findMany.mockResolvedValue([
      { id: 'dm-1', participants: [{ lastReadAt: null }] },
      { id: 'dm-2', participants: [{ lastReadAt: null }] },
    ]);
    mockPrisma.message.count.mockResolvedValue(7);

    const res = await getChannelInboxUnreadCount('c-1', 'admin-1');

    expect(res).toEqual({ count: 7 });
  });
});

// ─── blockChannelSubscriber ──────────────────────────────────────────

describe('blockChannelSubscriber', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(blockChannelSubscriber('c-1', 'u-1', 'sub-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('blocks subscriber and ends their DM', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'dm-1' });

    await blockChannelSubscriber('c-1', 'admin-1', 'sub-1');

    const safety = await import('../../safety/safety.service');
    expect(safety.blockUser).toHaveBeenCalledWith('admin-1', 'sub-1');
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'dm-1' },
      data: { status: 'ENDED' },
    }));
  });

  it('skips conversation update when no shared DM exists', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findFirst.mockResolvedValue(null);

    await blockChannelSubscriber('c-1', 'admin-1', 'sub-1');

    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it('swallows ConflictError (409) from blockUser when already blocked', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    const safety = await import('../../safety/safety.service');
    const conflictErr: any = new Error('already blocked');
    conflictErr.statusCode = 409;
    (safety.blockUser as any).mockRejectedValueOnce(conflictErr);

    await expect(blockChannelSubscriber('c-1', 'admin-1', 'sub-1')).resolves.toEqual({ blocked: true });
  });
});

// ─── deleteChannelDM ─────────────────────────────────────────────────

describe('deleteChannelDM', () => {
  it('rejects non-admin', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(deleteChannelDM('c-1', 'dm-1', 'u-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects DM that does not belong to channel', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ channelSourceId: 'other-channel' });

    await expect(deleteChannelDM('c-1', 'dm-1', 'admin-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('soft-deletes DM by setting status=ENDED', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.conversation.findUnique.mockResolvedValue({ channelSourceId: 'c-1' });

    await deleteChannelDM('c-1', 'dm-1', 'admin-1');

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'dm-1' },
      data: { status: 'ENDED' },
    });
  });
});
