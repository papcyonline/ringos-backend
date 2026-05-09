import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted so they're in scope before chat.service is imported) ─
const { mockPrisma } = vi.hoisted(() => {
  const tx = vi.fn(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  const mockPrisma: any = {
    conversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    conversationParticipant: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messageReaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    notification: {
      updateMany: vi.fn(),
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
  blockUser: vi.fn(),
}));
vi.mock('../streak.service', () => ({
  tryRecordMessageForStreak: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../shared/usage.service', () => ({
  getLimits: vi.fn().mockResolvedValue({
    pinnedChats: 3,
    bioMaxLength: 200,
    uploadMaxMb: 25,
  }),
  isPro: vi.fn().mockResolvedValue(false),
}));
vi.mock('open-graph-scraper', () => ({ default: vi.fn() }));

import {
  markConversationAsRead,
  editMessage,
  deleteMessage,
  togglePinMessage,
  getPinnedMessages,
  openViewOnce,
  toggleReaction,
  togglePin,
  toggleMute,
  setMute,
  toggleArchive,
  setDisappearingMessages,
  searchMessages,
  clearHistory,
} from '../chat.service';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';

// ── Helpers ────────────────────────────────────────────────────────────

function activeParticipant(over: Partial<any> = {}) {
  return {
    conversationId: 'conv-1',
    userId: 'user-1',
    leftAt: null,
    isPinned: false,
    isMuted: false,
    isArchived: false,
    mutedUntil: null,
    clearedAt: null,
    role: 'MEMBER',
    ...over,
  };
}

function baseMessage(over: Partial<any> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    content: 'hi',
    imageUrl: null,
    imageUrls: [],
    audioUrl: null,
    deletedAt: null,
    deletedFor: [],
    viewOnce: false,
    viewOnceOpened: false,
    isPinned: false,
    pinnedAt: null,
    pinnedById: null,
    metadata: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── markConversationAsRead ──────────────────────────────────────────

describe('markConversationAsRead', () => {
  it('throws when user is not a participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(markConversationAsRead('conv-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws when participant has left the conversation', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(
      activeParticipant({ leftAt: new Date() }),
    );
    await expect(markConversationAsRead('conv-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('writes lastReadAt and clears chat notifications atomically', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.conversationParticipant.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await markConversationAsRead('conv-1', 'user-1');

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.conversationParticipant.updateMany).toHaveBeenCalled();
    expect(mockPrisma.notification.updateMany).toHaveBeenCalled();
  });
});

// ─── editMessage ─────────────────────────────────────────────────────

describe('editMessage', () => {
  it('throws NotFoundError when message missing', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await expect(editMessage('m-x', 'user-1', 'new')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError when caller is not the sender', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ senderId: 'someone-else' }));
    await expect(editMessage('msg-1', 'user-1', 'new')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws ForbiddenError when message is already deleted', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ deletedAt: new Date() }));
    await expect(editMessage('msg-1', 'user-1', 'new')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('updates content and sets editedAt', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage());
    mockPrisma.message.update.mockResolvedValue({ ...baseMessage(), content: 'new' });

    const res = await editMessage('msg-1', 'user-1', 'new');

    expect(mockPrisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'msg-1' },
      data: expect.objectContaining({ content: 'new', editedAt: expect.any(Date) }),
    }));
    expect(res.content).toBe('new');
  });
});

// ─── deleteMessage ───────────────────────────────────────────────────

describe('deleteMessage', () => {
  it('mode=me hides the message for the user (push)', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ senderId: 'someone-else' }));
    mockPrisma.message.update.mockResolvedValue(baseMessage({ deletedFor: ['user-1'] }));

    await deleteMessage('msg-1', 'user-1', 'me');

    expect(mockPrisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'msg-1' },
      data: { deletedFor: { push: 'user-1' } },
    }));
  });

  it('mode=me is a no-op when already in deletedFor', async () => {
    const m = baseMessage({ deletedFor: ['user-1'] });
    mockPrisma.message.findUnique.mockResolvedValue(m);

    const res = await deleteMessage('msg-1', 'user-1', 'me');

    expect(res).toBe(m);
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it('mode=unsend rejects non-sender even if admin', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ senderId: 'someone-else' }));
    await expect(deleteMessage('msg-1', 'user-1', 'unsend')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mode=unsend hard-deletes message + reactions in a transaction', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage());

    const res = await deleteMessage('msg-1', 'user-1', 'unsend');

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.messageReaction.deleteMany).toHaveBeenCalledWith({ where: { messageId: 'msg-1' } });
    expect(mockPrisma.message.delete).toHaveBeenCalledWith({ where: { id: 'msg-1' } });
    expect(res).toMatchObject({ id: 'msg-1', unsent: true });
  });

  it('mode=everyone allows admin to delete other users\' messages', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ senderId: 'someone-else' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ role: 'ADMIN' }));
    mockPrisma.message.update.mockResolvedValue(baseMessage({ deletedAt: new Date() }));

    await deleteMessage('msg-1', 'user-1', 'everyone');

    expect(mockPrisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'msg-1' },
      data: expect.objectContaining({ deletedAt: expect.any(Date), content: '' }),
    }));
  });

  it('mode=everyone rejects non-admin non-sender', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ senderId: 'someone-else' }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ role: 'MEMBER' }));

    await expect(deleteMessage('msg-1', 'user-1', 'everyone')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws when message already deleted', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ deletedAt: new Date() }));
    await expect(deleteMessage('msg-1', 'user-1', 'everyone')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws NotFoundError when message missing', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await expect(deleteMessage('m-x', 'user-1', 'everyone')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─── togglePinMessage ────────────────────────────────────────────────

describe('togglePinMessage', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await expect(togglePinMessage('m-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects pin on a deleted message', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ deletedAt: new Date() }));
    await expect(togglePinMessage('msg-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('pins when previously unpinned, sets pinnedById and pinnedAt', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ isPinned: false }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.message.update.mockResolvedValue(baseMessage({ isPinned: true }));

    await togglePinMessage('msg-1', 'user-1');

    expect(mockPrisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isPinned: true,
        pinnedAt: expect.any(Date),
        pinnedById: 'user-1',
      }),
    }));
  });

  it('unpins and clears pinnedAt/pinnedById when previously pinned', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ isPinned: true }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.message.update.mockResolvedValue(baseMessage({ isPinned: false }));

    await togglePinMessage('msg-1', 'user-1');

    expect(mockPrisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isPinned: false,
        pinnedAt: null,
        pinnedById: null,
      }),
    }));
  });
});

// ─── getPinnedMessages ───────────────────────────────────────────────

describe('getPinnedMessages', () => {
  it('throws ForbiddenError if not a participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(getPinnedMessages('conv-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns pinned messages newest-first', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.message.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);

    const res = await getPinnedMessages('conv-1', 'user-1');
    expect(res).toHaveLength(2);
    expect(mockPrisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: 'conv-1', isPinned: true, deletedAt: null },
      orderBy: { pinnedAt: 'desc' },
    }));
  });
});

// ─── openViewOnce ────────────────────────────────────────────────────

describe('openViewOnce', () => {
  it('throws when not a view-once message', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ viewOnce: false }));
    await expect(openViewOnce('msg-1', 'user-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws when sender tries to open their own view-once', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(
      baseMessage({ viewOnce: true, senderId: 'user-1' }),
    );
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());

    await expect(openViewOnce('msg-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws when already opened', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(
      baseMessage({ viewOnce: true, senderId: 'sender', viewOnceOpened: true }),
    );
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());

    await expect(openViewOnce('msg-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('marks opened and wipes content/media on success', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(
      baseMessage({ viewOnce: true, senderId: 'sender', content: 'secret' }),
    );
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.message.update.mockResolvedValue({ id: 'msg-1', conversationId: 'conv-1' });

    const res = await openViewOnce('msg-1', 'user-1');

    expect(mockPrisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        viewOnceOpened: true,
        content: '',
        imageUrl: null,
        audioUrl: null,
      }),
    }));
    expect(res).toEqual({ messageId: 'msg-1', conversationId: 'conv-1' });
  });
});

// ─── toggleReaction ──────────────────────────────────────────────────

describe('toggleReaction', () => {
  it('rejects reaction on deleted message', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage({ deletedAt: new Date() }));
    await expect(toggleReaction('msg-1', 'user-1', '❤️')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('removes existing reaction (toggle off)', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.messageReaction.findUnique.mockResolvedValue({ id: 'react-1' });
    mockPrisma.messageReaction.delete.mockResolvedValue({});

    const res = await toggleReaction('msg-1', 'user-1', '❤️');

    expect(mockPrisma.messageReaction.delete).toHaveBeenCalledWith({ where: { id: 'react-1' } });
    expect(res.action).toBe('removed');
  });

  it('creates reaction when none exists', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(baseMessage());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.messageReaction.findUnique.mockResolvedValue(null);
    mockPrisma.messageReaction.create.mockResolvedValue({
      id: 'react-1',
      user: { displayName: 'Alice' },
    });

    const res = await toggleReaction('msg-1', 'user-1', '🔥');

    expect(mockPrisma.messageReaction.create).toHaveBeenCalled();
    expect(res).toMatchObject({ action: 'added', emoji: '🔥', displayName: 'Alice' });
  });
});

// ─── togglePin (conversation) ────────────────────────────────────────

describe('togglePin (conversation)', () => {
  it('rejects when pinned-chat limit hit', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ isPinned: false }));
    mockPrisma.conversationParticipant.count.mockResolvedValue(3);

    await expect(togglePin('user-1', 'conv-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('pins when below limit', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ isPinned: false }));
    mockPrisma.conversationParticipant.count.mockResolvedValue(1);
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isPinned: true });

    const res = await togglePin('user-1', 'conv-1');

    expect(res.isPinned).toBe(true);
    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isPinned: true },
    }));
  });

  it('unpinning skips the limit check', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ isPinned: true }));
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isPinned: false });

    await togglePin('user-1', 'conv-1');

    expect(mockPrisma.conversationParticipant.count).not.toHaveBeenCalled();
  });
});

// ─── toggleMute / setMute / toggleArchive ────────────────────────────

describe('toggleMute', () => {
  it('flips isMuted and clears mutedUntil', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ isMuted: false }));
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isMuted: true, mutedUntil: null });

    await toggleMute('user-1', 'conv-1');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isMuted: true, mutedUntil: null },
    }));
  });
});

describe('setMute', () => {
  it('null mutedUntil unmutes', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isMuted: false, mutedUntil: null });

    await setMute('user-1', 'conv-1', null);

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { mutedUntil: null, isMuted: false },
    }));
  });

  it('past timestamp is treated as unmute (defensive)', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isMuted: false, mutedUntil: null });

    const past = new Date(Date.now() - 60_000);
    await setMute('user-1', 'conv-1', past);

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { mutedUntil: null, isMuted: false },
    }));
  });

  it('future timestamp mutes until that time', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    const future = new Date(Date.now() + 60 * 60 * 1000);
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isMuted: true, mutedUntil: future });

    await setMute('user-1', 'conv-1', future);

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { mutedUntil: future, isMuted: true },
    }));
  });
});

describe('toggleArchive', () => {
  it('flips isArchived', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ isArchived: false }));
    mockPrisma.conversationParticipant.update.mockResolvedValue({ isArchived: true });

    await toggleArchive('user-1', 'conv-1');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isArchived: true },
    }));
  });
});

// ─── setDisappearingMessages ─────────────────────────────────────────

describe('setDisappearingMessages', () => {
  it('rejects invalid duration', async () => {
    await expect(setDisappearingMessages('conv-1', 'user-1', 9999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('valid 24h duration writes to conversation + drops a system message', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.conversation.update.mockResolvedValue({ id: 'conv-1', disappearAfterSecs: 86400 });
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
    mockPrisma.message.create.mockResolvedValue({ id: 'sys-msg' });

    const res = await setDisappearingMessages('conv-1', 'user-1', 86400);

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conv-1' },
      data: { disappearAfterSecs: 86400 },
    }));
    expect(mockPrisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isSystem: true,
        content: expect.stringContaining('24 hours'),
      }),
    }));
    expect(res.systemMessage).toEqual({ id: 'sys-msg' });
  });

  it('null duration writes a "turned off" system message', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.conversation.update.mockResolvedValue({ id: 'conv-1', disappearAfterSecs: null });
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
    mockPrisma.message.create.mockResolvedValue({ id: 'sys-msg' });

    await setDisappearingMessages('conv-1', 'user-1', null);

    expect(mockPrisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        content: expect.stringContaining('turned off'),
      }),
    }));
  });
});

// ─── searchMessages ──────────────────────────────────────────────────

describe('searchMessages', () => {
  it('passes query (case-insensitive contains) and excludes user-deleted', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.message.findMany.mockResolvedValue([{ id: 'm1' }]);

    const res = await searchMessages('conv-1', 'user-1', 'hello');

    expect(res).toHaveLength(1);
    expect(mockPrisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        conversationId: 'conv-1',
        deletedAt: null,
        NOT: { deletedFor: { has: 'user-1' } },
        content: { contains: 'hello', mode: 'insensitive' },
      }),
      take: 50,
    }));
  });

  it('respects clearedAt when participant has cleared history', async () => {
    const cleared = new Date('2026-04-01T00:00:00Z');
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant({ clearedAt: cleared }));
    mockPrisma.message.findMany.mockResolvedValue([]);

    await searchMessages('conv-1', 'user-1', 'hi');

    expect(mockPrisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { gt: cleared } }),
    }));
  });
});

// ─── clearHistory ────────────────────────────────────────────────────

describe('clearHistory', () => {
  it('writes clearedAt and lastReadAt for the participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(activeParticipant());
    mockPrisma.conversationParticipant.update.mockResolvedValue({});

    await clearHistory('conv-1', 'user-1');

    expect(mockPrisma.conversationParticipant.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId_userId: { conversationId: 'conv-1', userId: 'user-1' } },
      data: expect.objectContaining({
        clearedAt: expect.any(Date),
        lastReadAt: expect.any(Date),
      }),
    }));
  });

  it('rejects non-participants', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
    await expect(clearHistory('conv-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
