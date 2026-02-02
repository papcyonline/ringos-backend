import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Prisma (using vi.hoisted to avoid hoisting issues) ────────────
const { mockPrisma, mockIO, mockSocketRoom } = vi.hoisted(() => {
  const mockSocketRoom = {
    fetchSockets: vi.fn().mockResolvedValue([]),
  };

  const mockIO = {
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    in: vi.fn().mockReturnValue(mockSocketRoom),
  };

  const mockPrisma = {
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationParticipant: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    fcmToken: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };

  return { mockPrisma, mockIO, mockSocketRoom };
});

vi.mock('../../../config/database', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../../config/socket', () => ({
  getIO: () => mockIO,
}));

vi.mock('../../../config/firebase', () => ({
  getFirebaseApp: () => null,
}));

// ── Import after mocks ────────────────────────────────────────────────────
import {
  createNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  markConversationNotificationsAsRead,
  notifyChatMessage,
} from '../notification.service';

describe('notification.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── createNotification ─────────────────────────────────────────────────

  describe('createNotification', () => {
    it('should create a notification with all fields', async () => {
      const mockNotification = {
        id: 'notif-1',
        userId: 'user-1',
        type: 'chat_message',
        title: 'Gentle Owl',
        body: 'Hello there',
        imageUrl: '/uploads/avatars/owl.jpg',
        data: { conversationId: 'conv-1', senderId: 'sender-1' },
        isRead: false,
        createdAt: new Date(),
      };

      mockPrisma.notification.create.mockResolvedValue(mockNotification);

      const result = await createNotification({
        userId: 'user-1',
        type: 'chat_message',
        title: 'Gentle Owl',
        body: 'Hello there',
        imageUrl: '/uploads/avatars/owl.jpg',
        data: { conversationId: 'conv-1', senderId: 'sender-1' },
      });

      expect(result).toEqual(mockNotification);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: 'chat_message',
          title: 'Gentle Owl',
          body: 'Hello there',
          imageUrl: '/uploads/avatars/owl.jpg',
          data: { conversationId: 'conv-1', senderId: 'sender-1' },
        },
      });
    });

    it('should set imageUrl to null when not provided', async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-2',
        imageUrl: null,
      });

      await createNotification({
        userId: 'user-1',
        type: 'new_follower',
        title: 'Test',
        body: 'Test body',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ imageUrl: null }),
        }),
      );
    });

    it('should emit socket event to the user room', async () => {
      const mockNotification = { id: 'notif-3' };
      mockPrisma.notification.create.mockResolvedValue(mockNotification);

      await createNotification({
        userId: 'user-1',
        type: 'chat_message',
        title: 'Test',
        body: 'Test',
      });

      expect(mockIO.to).toHaveBeenCalledWith('user:user-1');
    });

    it('should store data as empty object when not provided', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-4' });

      await createNotification({
        userId: 'user-1',
        type: 'new_follower',
        title: 'Test',
        body: 'body',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ data: {} }),
        }),
      );
    });
  });

  // ── getNotifications ───────────────────────────────────────────────────

  describe('getNotifications', () => {
    it('should return up to 100 notifications ordered by createdAt desc', async () => {
      const mockList = [{ id: '1' }, { id: '2' }];
      mockPrisma.notification.findMany.mockResolvedValue(mockList);

      const result = await getNotifications('user-1');

      expect(result).toEqual(mockList);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    });
  });

  // ── getUnreadCount ─────────────────────────────────────────────────────

  describe('getUnreadCount', () => {
    it('should return the unread count', async () => {
      mockPrisma.notification.count.mockResolvedValue(5);

      const result = await getUnreadCount('user-1');

      expect(result).toEqual({ count: 5 });
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', isRead: false },
      });
    });
  });

  // ── markAsRead ─────────────────────────────────────────────────────────

  describe('markAsRead', () => {
    it('should mark a notification as read for the correct user', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

      await markAsRead('user-1', 'notif-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'notif-1', userId: 'user-1' },
        data: { isRead: true },
      });
    });
  });

  // ── markAllAsRead ──────────────────────────────────────────────────────

  describe('markAllAsRead', () => {
    it('should mark all unread notifications as read', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 });

      await markAllAsRead('user-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isRead: false },
        data: { isRead: true },
      });
    });
  });

  // ── markConversationNotificationsAsRead ─────────────────────────────────

  describe('markConversationNotificationsAsRead', () => {
    it('should mark chat_message notifications for specific conversation', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });

      await markConversationNotificationsAsRead('user-1', 'conv-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          isRead: false,
          type: 'chat_message',
          data: { path: ['conversationId'], equals: 'conv-1' },
        },
        data: { isRead: true },
      });
    });
  });

  // ── notifyChatMessage ──────────────────────────────────────────────────

  describe('notifyChatMessage', () => {
    it('should fetch sender avatar and include in notification', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'recipient-1' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({
        avatarUrl: '/uploads/avatars/sender.jpg',
      });
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-chat' });
      mockSocketRoom.fetchSockets.mockResolvedValue([]);

      await notifyChatMessage('conv-1', 'sender-1', 'Gentle Owl', 'Hello!');

      // Should have fetched sender's avatar
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'sender-1' },
        select: { avatarUrl: true },
      });

      // Notification should include imageUrl and senderAvatarUrl in data
      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'chat_message',
          title: 'Gentle Owl',
          body: 'Hello!',
          imageUrl: '/uploads/avatars/sender.jpg',
          data: expect.objectContaining({
            senderAvatarUrl: '/uploads/avatars/sender.jpg',
            conversationId: 'conv-1',
            senderId: 'sender-1',
          }),
        }),
      });
    });

    it('should handle sender without avatar gracefully', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'recipient-1' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({ avatarUrl: null });
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-no-avatar' });
      mockSocketRoom.fetchSockets.mockResolvedValue([]);

      await notifyChatMessage('conv-1', 'sender-1', 'Shy Panda', 'Hi!');

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          imageUrl: null,
          data: expect.objectContaining({
            senderAvatarUrl: null,
          }),
        }),
      });
    });

    it('should skip notification for users in the conversation room', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'in-room-user' },
        { userId: 'offline-user' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({ avatarUrl: null });

      const mockSocket = { userId: 'in-room-user' };
      mockSocketRoom.fetchSockets.mockResolvedValue([mockSocket]);
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-skip' });

      await notifyChatMessage('conv-1', 'sender-1', 'Test', 'Hello');

      // Should only create one notification (for offline-user)
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'offline-user' }),
        }),
      );
    });

    it('should not create notifications when no participants', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);

      await notifyChatMessage('conv-1', 'sender-1', 'Test', 'Hello');

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('should truncate long messages to 100 characters', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'recipient-1' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({ avatarUrl: null });
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-long' });
      mockSocketRoom.fetchSockets.mockResolvedValue([]);

      const longMessage = 'A'.repeat(200);
      await notifyChatMessage('conv-1', 'sender-1', 'Test', longMessage);

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            body: 'A'.repeat(97) + '...',
          }),
        }),
      );
    });

    it('should use "Sent a voice message" for audio messages', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'recipient-1' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({ avatarUrl: null });
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-audio' });
      mockSocketRoom.fetchSockets.mockResolvedValue([]);

      await notifyChatMessage('conv-1', 'sender-1', 'Test', 'content', {
        audioUrl: '/uploads/audio/voice.m4a',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            body: 'Sent a voice message',
          }),
        }),
      );
    });

    it('should use "Sent an image" for image-only messages', async () => {
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'recipient-1' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({ avatarUrl: null });
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-img' });
      mockSocketRoom.fetchSockets.mockResolvedValue([]);

      await notifyChatMessage('conv-1', 'sender-1', 'Test', '', {
        imageUrl: '/uploads/images/photo.jpg',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            body: 'Sent an image',
          }),
        }),
      );
    });
  });
});
