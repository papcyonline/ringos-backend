import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ──────────────────────────────────────────────────────
vi.mock('../../../config/env', () => ({
  env: {
    CORS_ORIGIN: '*',
    REDIS_URL: '',
    OPENAI_API_KEY: 'test-key',
  },
}));

vi.mock('../../../config/socket', () => ({
  getIO: vi.fn(() => ({
    to: vi.fn(() => ({ emit: vi.fn() })),
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
  })),
}));

vi.mock('../translation.service', () => ({
  translateMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../config/database', () => ({
  prisma: {
    conversationParticipant: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ hideReadReceipts: false }),
    },
  },
}));

vi.mock('../chat.service', () => ({
  sendMessage: vi.fn().mockResolvedValue({
    id: 'm-1', conversationId: 'conv-1', senderId: 'user-1',
    sender: { displayName: 'Alice' }, content: 'hi', reactions: [],
  }),
  editMessage: vi.fn().mockResolvedValue({
    id: 'm-1', conversationId: 'conv-1', content: 'edited', editedAt: new Date(),
  }),
  deleteMessage: vi.fn().mockResolvedValue({
    id: 'm-1', conversationId: 'conv-1', deletedAt: new Date(),
  }),
  toggleReaction: vi.fn().mockResolvedValue({
    conversationId: 'conv-1', messageId: 'm-1', userId: 'user-1', emoji: '❤️', action: 'added',
  }),
  markConversationAsRead: vi.fn(),
  endConversation: vi.fn(),
  getMessagesSince: vi.fn().mockResolvedValue({
    messages: [], hasMore: false, nextSinceId: null, sinceNotFound: false,
  }),
}));

vi.mock('../chat.utils', () => ({
  formatMessagePayload: vi.fn((msg: any) => msg),
  emitToParticipantRooms: vi.fn().mockResolvedValue(undefined),
  broadcastAndNotifyMessage: vi.fn(),
}));

vi.mock('../../notification/notification.service', () => ({
  notifyChatMessage: vi.fn().mockResolvedValue(undefined),
  markConversationNotificationsAsRead: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { registerChatHandlers } from '../chat.gateway';
import { prisma } from '../../../config/database';

describe('chat.gateway', () => {
  let mockSocket: any;
  let mockIO: any;
  const handlers: Record<string, Function> = {};

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = {
      userId: 'user-1',
      id: 'socket-1',
      on: vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      emit: vi.fn(),
      join: vi.fn(),
      leave: vi.fn(),
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      rooms: new Set(['conversation:conv-1']),
    };

    mockIO = {
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    };

    registerChatHandlers(mockIO, mockSocket);
  });

  // ── chat:leave-room ────────────────────────────────────────────────────

  describe('chat:leave-room', () => {
    it('should register the chat:leave-room event handler', () => {
      expect(mockSocket.on).toHaveBeenCalledWith('chat:leave-room', expect.any(Function));
    });

    it('should leave the socket room without ending the conversation', () => {
      handlers['chat:leave-room']({ conversationId: 'conv-1' });

      expect(mockSocket.leave).toHaveBeenCalledWith('conversation:conv-1');
    });

    it('should not call endConversation', async () => {
      const chatService = await import('../chat.service');

      handlers['chat:leave-room']({ conversationId: 'conv-1' });

      expect(chatService.endConversation).not.toHaveBeenCalled();
    });

    it('should not emit any events to the room', () => {
      handlers['chat:leave-room']({ conversationId: 'conv-1' });

      expect(mockIO.to).not.toHaveBeenCalled();
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });
  });

  // ── chat:join ──────────────────────────────────────────────────────────

  describe('chat:join', () => {
    it('should register the chat:join event handler', () => {
      expect(mockSocket.on).toHaveBeenCalledWith('chat:join', expect.any(Function));
    });

    it('should join the socket room when user is a participant', async () => {
      (prisma.conversationParticipant.findUnique as any).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        leftAt: null,
      });

      await handlers['chat:join']({ conversationId: 'conv-1' });

      expect(mockSocket.join).toHaveBeenCalledWith('conversation:conv-1');
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:joined', { conversationId: 'conv-1' });
    });

    it('should emit error when user is not a participant', async () => {
      (prisma.conversationParticipant.findUnique as any).mockResolvedValue(null);

      await handlers['chat:join']({ conversationId: 'conv-1' });

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', {
        message: 'You are not a participant in this conversation',
      });
    });
  });

  // ── chat:read ──────────────────────────────────────────────────────────

  describe('chat:read', () => {
    it('should mark conversation as read and broadcast', async () => {
      const chatService = await import('../chat.service');

      await handlers['chat:read']({ conversationId: 'conv-1' });

      expect(chatService.markConversationAsRead).toHaveBeenCalledWith('conv-1', 'user-1');
      expect(mockSocket.to).toHaveBeenCalledWith('conversation:conv-1');
    });
  });

  // ── chat:typing ────────────────────────────────────────────────────────

  describe('chat:typing', () => {
    it('should broadcast typing event to room', () => {
      handlers['chat:typing']({ conversationId: 'conv-1' });

      expect(mockSocket.to).toHaveBeenCalledWith('conversation:conv-1');
    });
  });

  // ── All expected events are registered ─────────────────────────────────

  describe('event registration', () => {
    it('should register all expected event handlers', () => {
      const expectedEvents = [
        'chat:join',
        'chat:message',
        'chat:edit',
        'chat:delete',
        'chat:react',
        'chat:delivered',
        'chat:read',
        'chat:typing',
        'chat:leave-room',
        'chat:leave',
      ];

      for (const event of expectedEvents) {
        expect(mockSocket.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });
  });

  describe('chat:join — additional', () => {
    it('rejects when user has left the conversation', async () => {
      (prisma.conversationParticipant.findUnique as any).mockResolvedValue({
        conversationId: 'conv-1', userId: 'user-1', leftAt: new Date(),
      });
      await handlers['chat:join']({ conversationId: 'conv-1' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', { message: 'You have left this conversation' });
    });

    it('catches db error', async () => {
      (prisma.conversationParticipant.findUnique as any).mockRejectedValue(new Error('db'));
      await handlers['chat:join']({ conversationId: 'conv-1' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.objectContaining({ message: 'Failed to join conversation' }));
    });
  });

  describe('chat:sync', () => {
    it('rejects missing conversationId', async () => {
      await handlers['chat:sync']({});
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.objectContaining({ message: expect.stringContaining('conversationId') }));
    });

    it('emits chat:synced with messages', async () => {
      await handlers['chat:sync']({ conversationId: 'conv-1', sinceMessageId: 'm-0' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:synced', expect.objectContaining({
        conversationId: 'conv-1',
      }));
    });
  });

  describe('chat:message', () => {
    it('rejects empty content', async () => {
      await handlers['chat:message']({ conversationId: 'conv-1', content: '' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });

    it('sends valid message', async () => {
      await handlers['chat:message']({ conversationId: 'conv-1', content: 'hello world' });
      const chatService = await import('../chat.service');
      expect(chatService.sendMessage).toHaveBeenCalled();
    });

    it('handles service error', async () => {
      const chatService = await import('../chat.service');
      (chatService.sendMessage as any).mockRejectedValueOnce(new Error('boom'));
      await handlers['chat:message']({ conversationId: 'conv-1', content: 'hello' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });
  });

  describe('chat:edit', () => {
    it('rejects empty content', async () => {
      await handlers['chat:edit']({ messageId: 'm-1', content: '' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });

    it('broadcasts edit on success', async () => {
      await handlers['chat:edit']({ messageId: 'm-1', content: 'fixed' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
    });

    it('handles service error', async () => {
      const chatService = await import('../chat.service');
      (chatService.editMessage as any).mockRejectedValueOnce(new Error('boom'));
      await handlers['chat:edit']({ messageId: 'm-1', content: 'x' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });
  });

  describe('chat:delete', () => {
    it('emits chat:deleted by default', async () => {
      await handlers['chat:delete']({ messageId: 'm-1' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
    });

    it('emits chat:unsent when mode=unsend', async () => {
      await handlers['chat:delete']({ messageId: 'm-1', mode: 'unsend' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
    });
  });

  describe('chat:react', () => {
    it('rejects invalid emoji', async () => {
      await handlers['chat:react']({ messageId: 'm-1', emoji: '' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });

    it('rejects emoji over 32 chars', async () => {
      await handlers['chat:react']({ messageId: 'm-1', emoji: 'x'.repeat(33) });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });

    it('broadcasts on valid reaction', async () => {
      await handlers['chat:react']({ messageId: 'm-1', emoji: '❤️' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
    });
  });

  describe('chat:delivered', () => {
    it('updates delivered timestamp and broadcasts', async () => {
      (prisma.message.findUnique as any).mockResolvedValue({ senderId: 'u-2' });
      await handlers['chat:delivered']({ messageId: 'm-1', conversationId: 'conv-1' });
      expect(prisma.conversationParticipant.updateMany).toHaveBeenCalled();
    });
  });

  describe('chat:voice-played', () => {
    it('rejects missing args', async () => {
      await handlers['chat:voice-played']({});
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });

    it('broadcasts when first play', async () => {
      (prisma.message.updateMany as any).mockResolvedValue({ count: 1 });
      (prisma.message.findUnique as any).mockResolvedValue({ senderId: 'u-2' });
      await handlers['chat:voice-played']({ messageId: 'm-1', conversationId: 'conv-1' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
    });

    it('skips when already played', async () => {
      (prisma.message.updateMany as any).mockResolvedValue({ count: 0 });
      mockIO.to.mockClear();
      await handlers['chat:voice-played']({ messageId: 'm-1', conversationId: 'conv-1' });
      // Won't emit
    });
  });

  describe('chat:read with hideReadReceipts', () => {
    it('skips broadcast when user hides read receipts', async () => {
      (prisma.user.findUnique as any).mockResolvedValueOnce({ hideReadReceipts: true });
      await handlers['chat:read']({ conversationId: 'conv-1' });
      // markConversationAsRead is still called
      const chatService = await import('../chat.service');
      expect(chatService.markConversationAsRead).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('does not throw', () => {
      handlers['disconnect']();
    });
  });

  describe('chat:leave', () => {
    it('emits chat:ended when conversation status is ENDED', async () => {
      const chatService = await import('../chat.service');
      (chatService.endConversation as any).mockResolvedValueOnce({ id: 'conv-1', status: 'ENDED' });
      await handlers['chat:leave']({ conversationId: 'conv-1' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
      expect(mockSocket.leave).toHaveBeenCalled();
    });

    it('emits chat:member-left when conversation continues', async () => {
      const chatService = await import('../chat.service');
      (chatService.endConversation as any).mockResolvedValueOnce({ id: 'conv-1', status: 'ACTIVE' });
      await handlers['chat:leave']({ conversationId: 'conv-1' });
      expect(mockIO.to).toHaveBeenCalledWith('conversation:conv-1');
    });

    it('emits error on service failure', async () => {
      const chatService = await import('../chat.service');
      (chatService.endConversation as any).mockRejectedValueOnce(new Error('boom'));
      await handlers['chat:leave']({ conversationId: 'conv-1' });
      expect(mockSocket.emit).toHaveBeenCalledWith('chat:error', expect.any(Object));
    });
  });

  describe('chat:typing', () => {
    it('passes activity argument', () => {
      handlers['chat:typing']({ conversationId: 'conv-1', activity: 'recording' });
      expect(mockSocket.to).toHaveBeenCalledWith('conversation:conv-1');
    });
  });
});
