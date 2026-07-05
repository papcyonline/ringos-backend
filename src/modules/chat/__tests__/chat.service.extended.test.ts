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
      count: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0), // no-reply gate; 0 = never gated in tests
    },
    user: {
      findUnique: vi.fn(),
    },
    follow: {
      findFirst: vi.fn(),
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
  blockUser: vi.fn(),
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
  getOrCreateDirectConversation,
  endConversation,
  getMessages,
  getMessagesSince,
  getAllGroups,
  getAllChannels,
  searchChannels,
  getRecommendedChannels,
  forwardMessage,
  forwardMessageToMany,
  getMessageInfo,
  searchMessagesGlobal,
  sendMessage,
} from '../chat.service';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
  // sendMessage fires updateMany as fire-and-forget; default to a resolved promise.
  mockPrisma.conversationParticipant.updateMany.mockResolvedValue({ count: 0 });
});

const baseConv = (over: Partial<any> = {}) => ({
  id: 'conv-1',
  type: 'HUMAN_MATCHED',
  status: 'ACTIVE',
  isPublic: true,
  isChannel: false,
  isVerified: false,
  adminsOnlyMessages: false,
  disappearAfterSecs: null,
  participants: [],
  ...over,
});

const activeP = (over: Partial<any> = {}) => ({
  conversationId: 'conv-1',
  userId: 'user-1',
  leftAt: null,
  isPinned: false,
  isMuted: false,
  isArchived: false,
  mutedUntil: null,
  clearedAt: null,
  lastReadAt: null,
  lastDeliveredAt: null,
  role: 'MEMBER',
  ...over,
});

// ─── getConversation ─────────────────────────────────────────────────

describe('getConversation', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    await expect(getConversation('c-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError when user is not a participant', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      ...baseConv(),
      participants: [{ user: { id: 'other' }, leftAt: null }],
    });

    await expect(getConversation('conv-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── getOrCreateDirectConversation ───────────────────────────────────

describe('getOrCreateDirectConversation', () => {
  it('rejects self-conversation', async () => {
    await expect(getOrCreateDirectConversation('user-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when blocked', async () => {
    const safety = await import('../../safety/safety.service');
    (safety.isBlocked as any).mockResolvedValueOnce(true);

    await expect(getOrCreateDirectConversation('user-1', 'user-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns existing direct conversation if present', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'existing-conv', participants: [] });

    const res = await getOrCreateDirectConversation('user-1', 'user-2');

    expect(res.id).toBe('existing-conv');
    expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
  });

  it('creates new direct conversation when none exists', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: 'new-conv', participants: [] });
    // Privacy gate added in the message-requests feature: target must
    // exist for the conversation to be created. Default to EVERYONE +
    // recipient follows the sender so the convo is created normally
    // (not as a pending request).
    mockPrisma.user.findUnique.mockResolvedValue({ messagePrivacy: 'EVERYONE' });
    mockPrisma.follow.findFirst.mockResolvedValue({ id: 'f-1' });

    await getOrCreateDirectConversation('user-1', 'user-2');

    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'HUMAN_MATCHED',
        status: 'ACTIVE',
      }),
    }));
  });
});

// ─── endConversation ─────────────────────────────────────────────────

describe('endConversation', () => {
  it('throws when conversation missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    await expect(endConversation('c-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when participant missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(endConversation('conv-1', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('groups: marks caller as left without ending the conversation', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ type: 'GROUP' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());

    await endConversation('conv-1', 'user-1');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ leftAt: expect.any(Date) }),
    }));
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it('groups: idempotent when caller already left', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ type: 'GROUP' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP({ leftAt: new Date() }));

    await endConversation('conv-1', 'user-1');

    expect(mockPrisma.conversationParticipant.update).not.toHaveBeenCalled();
  });

  it('direct DMs: ends conversation + marks caller as left', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ type: 'HUMAN_MATCHED', status: 'ACTIVE' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());

    await endConversation('conv-1', 'user-1');

    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('direct DMs: no-op when already ended and caller already left', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ type: 'HUMAN_MATCHED', status: 'ENDED' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP({ leftAt: new Date() }));

    await endConversation('conv-1', 'user-1');

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── getMessages ─────────────────────────────────────────────────────

describe('getMessages', () => {
  it('returns empty page when cursor message was hard-deleted', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce(activeP())  // verifyParticipant
      .mockResolvedValueOnce({ clearedAt: null });  // clearedAt lookup
    mockPrisma.message.findUnique.mockResolvedValue(null);

    const res = await getMessages('conv-1', 'user-1', 1, 50, 'deleted-msg');

    expect(res).toEqual({ data: [], page: 1, limit: 50, hasMore: false, nextCursor: null });
  });

  it('returns paginated messages and computes hasMore', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce(activeP())
      .mockResolvedValueOnce({ clearedAt: null });
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { lastReadAt: null, lastDeliveredAt: null },
    ]);
    // 51 messages returned for limit=50 → hasMore=true
    const msgs = Array.from({ length: 51 }, (_, i) => ({
      id: `m-${i}`,
      senderId: 'user-1',
      createdAt: new Date(2026, 4, 8, 12, 0, i),
    }));
    mockPrisma.message.findMany.mockResolvedValue(msgs);

    const res = await getMessages('conv-1', 'user-1');

    expect(res.data).toHaveLength(50);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe('m-49');
  });

  it('uses cursor-based query when cursor provided', async () => {
    const cursorTime = new Date('2026-05-01');
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce(activeP())
      .mockResolvedValueOnce({ clearedAt: null });
    mockPrisma.message.findUnique.mockResolvedValue({ createdAt: cursorTime });
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    await getMessages('conv-1', 'user-1', 1, 50, 'cursor-msg');

    expect(mockPrisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: { lt: cursorTime },
      }),
    }));
  });
});

// ─── getMessagesSince ────────────────────────────────────────────────

describe('getMessagesSince', () => {
  it('returns messages newer than sinceMessageId', async () => {
    const sinceTime = new Date('2026-05-01');
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.message.findUnique.mockResolvedValue({ createdAt: sinceTime });
    mockPrisma.message.findMany.mockResolvedValue([
      { id: 'm-1', senderId: 'user-1', createdAt: new Date() },
    ]);
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    const res = await getMessagesSince('conv-1', 'user-1', 'msg-cursor');

    expect(res.messages).toHaveLength(1);
    expect(res.sinceNotFound).toBe(false);
  });

  it('signals sinceNotFound when cursor message was hard-deleted (and floor exists)', async () => {
    const lastRead = new Date('2026-05-01');
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP({ lastReadAt: lastRead }));
    mockPrisma.message.findUnique.mockResolvedValue(null);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

    const res = await getMessagesSince('conv-1', 'user-1', 'deleted-cursor');

    expect(res.sinceNotFound).toBe(true);
  });

  it('returns empty when cursor missing and no safe floor', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.message.findUnique.mockResolvedValue(null);

    const res = await getMessagesSince('conv-1', 'user-1', 'deleted-cursor');

    expect(res).toEqual({ messages: [], hasMore: false, nextSinceId: null, sinceNotFound: true });
  });
});

// ─── getAllGroups / getAllChannels ───────────────────────────────────

describe('getAllGroups / getAllChannels', () => {
  it('annotates each conversation with isMember and memberCount', async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([
      {
        id: 'g-1',
        participants: [
          { userId: 'user-1', leftAt: null, role: 'ADMIN' },
          { userId: 'user-2', leftAt: null, role: 'MEMBER' },
          { userId: 'user-3', leftAt: new Date(), role: 'MEMBER' },
        ],
      },
    ]);

    const res = await getAllGroups('user-1');

    expect(res[0]).toMatchObject({
      memberCount: 2,
      isMember: true,
      isAdmin: true,
    });
  });

  it('getAllChannels filters isChannel=true', async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    await getAllChannels('user-1');

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isChannel: true }),
    }));
  });
});

// ─── getRecommendedChannels ──────────────────────────────────────────

describe('getRecommendedChannels', () => {
  it('sorts by subscriber count descending and slices to limit', async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', name: 'A', participants: Array.from({ length: 5 }, (_, i) => ({ userId: `u${i}` })) },
      { id: 'c2', name: 'B', participants: Array.from({ length: 50 }, (_, i) => ({ userId: `u${i}` })) },
      { id: 'c3', name: 'C', participants: Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}` })) },
    ]);

    const res = await getRecommendedChannels('user-1', undefined, 2);

    expect(res).toHaveLength(2);
    expect(res[0].id).toBe('c2');
    expect(res[1].id).toBe('c3');
  });

  it('passes category filter to query', async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    await getRecommendedChannels('user-1', 'tech');

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        category: { equals: 'tech', mode: 'insensitive' },
      }),
    }));
  });
});

// ─── searchChannels ──────────────────────────────────────────────────

describe('searchChannels', () => {
  it('returns empty for short query', async () => {
    expect(await searchChannels('a', 'user-1')).toEqual([]);
    expect(mockPrisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('returns formatted results with isMember/isAdmin', async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([
      {
        id: 'c1',
        name: 'tech',
        participants: [{ userId: 'user-1', role: 'MEMBER' }],
      },
    ]);

    const res = await searchChannels('tech', 'user-1');

    expect(res[0]).toMatchObject({ id: 'c1', isMember: true, isAdmin: false });
  });
});

// ─── sendMessage ─────────────────────────────────────────────────────

describe('sendMessage', () => {
  it('throws NotFoundError when conversation missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(sendMessage('c-x', 'user-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects ENDED conversation', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ status: 'ENDED' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());

    await expect(sendMessage('conv-1', 'user-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when sender is not a participant', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(sendMessage('conv-1', 'user-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when sender has left', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP({ leftAt: new Date() }));

    await expect(sendMessage('conv-1', 'user-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects member sending in admins-only group', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ type: 'GROUP', adminsOnlyMessages: true }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP({ role: 'MEMBER' }));

    await expect(sendMessage('conv-1', 'user-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects DM when blocked', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'user-1' },
      { userId: 'user-2' },
    ]);
    const safety = await import('../../safety/safety.service');
    (safety.isBlocked as any).mockResolvedValueOnce(true);

    await expect(sendMessage('conv-1', 'user-1', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when replyToId missing', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    mockPrisma.message.findFirst.mockResolvedValue(null);

    await expect(sendMessage('conv-1', 'user-1', 'hi', { replyToId: 'ghost' }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it('creates message with disappearing TTL when conversation enables it', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv({ disappearAfterSecs: 86400 }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    mockPrisma.message.create.mockResolvedValue({ id: 'm-1' });
    mockPrisma.conversation.update.mockResolvedValue({});

    await sendMessage('conv-1', 'user-1', 'hi');

    expect(mockPrisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ expiresAt: expect.any(Date) }),
    }));
  });

  it('mirrors imageUrls[0] into legacy imageUrl field', async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    mockPrisma.message.create.mockResolvedValue({ id: 'm-1' });
    mockPrisma.conversation.update.mockResolvedValue({});

    await sendMessage('conv-1', 'user-1', '', {
      imageUrls: ['/img1.jpg', '/img2.jpg'],
    });

    expect(mockPrisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        imageUrl: '/img1.jpg',
        imageUrls: ['/img1.jpg', '/img2.jpg'],
      }),
    }));
  });
});

// ─── forwardMessage / forwardMessageToMany ───────────────────────────

describe('forwardMessageToMany', () => {
  it('rejects empty target list', async () => {
    await expect(forwardMessageToMany('m-1', [], 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects more than MAX_FORWARD_TARGETS distinct targets', async () => {
    await expect(
      forwardMessageToMany('m-1', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], 'user-1'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when source message missing', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await expect(forwardMessageToMany('m-x', ['c1'], 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects forwarding a deleted message', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      content: 'x', imageUrl: null, imageUrls: [], audioUrl: null,
      audioDuration: null, conversationId: 'src', deletedAt: new Date(),
    });
    await expect(forwardMessageToMany('m-1', ['c1'], 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('forwards to multiple targets and returns the new messages', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      content: 'hi', imageUrl: null, imageUrls: [], audioUrl: null,
      audioDuration: null, conversationId: 'src', deletedAt: null,
    });
    // Source verifyParticipant + each target verifyParticipant + each sendMessage's verifyParticipant
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    mockPrisma.message.create.mockResolvedValue({ id: 'fwd-1' });
    mockPrisma.conversation.update.mockResolvedValue({});

    const res = await forwardMessageToMany('m-1', ['c-a', 'c-b'], 'user-1');

    expect(res).toHaveLength(2);
  });

  it('forwardMessage delegates to forwardMessageToMany and returns first result', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      content: 'hi', imageUrl: null, imageUrls: [], audioUrl: null,
      audioDuration: null, conversationId: 'src', deletedAt: null,
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversation.findUnique.mockResolvedValue(baseConv());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'user-1' }]);
    mockPrisma.message.create.mockResolvedValue({ id: 'fwd-1' });
    mockPrisma.conversation.update.mockResolvedValue({});

    const res = await forwardMessage('m-1', 'c-target', 'user-1');

    expect(res).toEqual({ id: 'fwd-1' });
  });
});

// ─── getMessageInfo ──────────────────────────────────────────────────

describe('getMessageInfo', () => {
  it('throws NotFoundError when message missing', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await expect(getMessageInfo('m-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when caller is not the sender', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 'm-1', conversationId: 'conv-1', senderId: 'someone-else', createdAt: new Date(),
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());

    await expect(getMessageInfo('m-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns null deliveredAt/readAt when timestamps predate the message', async () => {
    const msgCreated = new Date('2026-05-08T12:00:00Z');
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 'm-1', conversationId: 'conv-1', senderId: 'user-1', createdAt: msgCreated,
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      {
        userId: 'u-2',
        lastReadAt: new Date('2026-05-08T11:00:00Z'),
        lastDeliveredAt: new Date('2026-05-08T11:00:00Z'),
        user: { displayName: 'Bob', avatarUrl: null },
      },
    ]);

    const res = await getMessageInfo('m-1', 'user-1');

    expect(res[0].deliveredAt).toBeNull();
    expect(res[0].readAt).toBeNull();
  });

  it('returns timestamps when participant read after message creation', async () => {
    const msgCreated = new Date('2026-05-08T12:00:00Z');
    const readTime = new Date('2026-05-08T13:00:00Z');
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 'm-1', conversationId: 'conv-1', senderId: 'user-1', createdAt: msgCreated,
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeP());
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      {
        userId: 'u-2',
        lastReadAt: readTime,
        lastDeliveredAt: readTime,
        user: { displayName: 'Bob', avatarUrl: null },
      },
    ]);

    const res = await getMessageInfo('m-1', 'user-1');

    expect(res[0].deliveredAt).toEqual(readTime);
    expect(res[0].readAt).toEqual(readTime);
  });
});

// ─── searchMessagesGlobal ────────────────────────────────────────────

describe('searchMessagesGlobal', () => {
  it('returns [] when user has no conversations', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);
    expect(await searchMessagesGlobal('user-1', 'hi')).toEqual([]);
  });

  it('honors per-conversation clearedAt', async () => {
    const cleared = new Date('2026-04-01');
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { conversationId: 'c-1', clearedAt: null },
      { conversationId: 'c-2', clearedAt: cleared },
    ]);
    mockPrisma.message.findMany.mockResolvedValue([]);

    await searchMessagesGlobal('user-1', 'hello');

    const callArgs = mockPrisma.message.findMany.mock.calls[0][0];
    const orClause = callArgs.where.AND.find((c: any) => c.OR)?.OR;
    expect(orClause).toEqual(expect.arrayContaining([
      { conversationId: { in: ['c-1'] } },
      { conversationId: 'c-2', createdAt: { gt: cleared } },
    ]));
  });
});
