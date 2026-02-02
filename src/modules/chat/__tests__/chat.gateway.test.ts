import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ──────────────────────────────────────────────────────
vi.mock('../../../config/database', () => ({
  prisma: {
    conversationParticipant: {
      findUnique: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../safety/moderation.service', () => ({
  moderateContent: vi.fn().mockResolvedValue({ flagged: false, cleaned: 'test' }),
}));

vi.mock('../chat.service', () => ({
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  toggleReaction: vi.fn(),
  markConversationAsRead: vi.fn(),
  endConversation: vi.fn(),
}));

vi.mock('../chat.utils', () => ({
  formatMessagePayload: vi.fn((msg: any) => msg),
}));

vi.mock('../../notification/notification.service', () => ({
  notifyChatMessage: vi.fn().mockResolvedValue(undefined),
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
});
