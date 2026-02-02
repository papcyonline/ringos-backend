import { Prisma } from '@prisma/client';
import * as admin from 'firebase-admin';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { getFirebaseApp } from '../../config/firebase';
import { logger } from '../../shared/logger';

export async function getNotifications(userId: string) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getUnreadCount(userId: string) {
  const count = await prisma.notification.count({
    where: { userId, isRead: false },
  });
  return { count };
}

export async function markAsRead(userId: string, notificationId: string) {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
}

export async function markAllAsRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
}

export async function markConversationNotificationsAsRead(userId: string, conversationId: string) {
  await prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
      type: 'chat_message',
      data: { path: ['conversationId'], equals: conversationId },
    },
    data: { isRead: true },
  });
}

export async function createNotification(data: {
  userId: string;
  type: string;
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, unknown>;
}) {
  const notification = await prisma.notification.create({
    data: {
      userId: data.userId,
      type: data.type,
      title: data.title,
      body: data.body,
      imageUrl: data.imageUrl ?? null,
      data: (data.data ?? {}) as Prisma.InputJsonValue,
    },
  });

  // Emit real-time event to the user's socket room
  try {
    getIO().to(`user:${data.userId}`).emit('notification:new', notification);
  } catch {
    // Socket may not be initialized in tests
  }

  return notification;
}

export async function registerFcmToken(userId: string, token: string) {
  await prisma.fcmToken.upsert({
    where: { token },
    create: { userId, token },
    update: { userId },
  });
}

export async function removeFcmToken(token: string) {
  await prisma.fcmToken.deleteMany({
    where: { token },
  });
}

/**
 * Send a push notification via FCM to all devices registered for a user.
 */
async function sendPushToUser(userId: string, payload: {
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}) {
  const app = getFirebaseApp();
  if (!app) return;

  const tokens = await prisma.fcmToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (tokens.length === 0) return;

  const message: admin.messaging.MulticastMessage = {
    tokens: tokens.map((t) => t.token),
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
    },
    data: payload.data ?? {},
    android: {
      priority: 'high',
      notification: { channelId: 'yomeet_default', sound: 'default' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(tokens[idx].token);
          }
        }
      });
      if (invalidTokens.length > 0) {
        await prisma.fcmToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
        logger.debug({ count: invalidTokens.length, userId }, 'Cleaned up invalid FCM tokens');
      }
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to send FCM push notification');
  }
}

/**
 * Notify all other participants in a conversation about a new chat message.
 * Creates in-app notifications and sends push notifications.
 */
export async function notifyChatMessage(
  conversationId: string,
  senderId: string,
  senderName: string,
  content: string,
  options?: { imageUrl?: string; audioUrl?: string },
) {
  // Get all participants except the sender
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId, userId: { not: senderId }, leftAt: null },
    select: { userId: true },
  });

  if (participants.length === 0) return;

  // Check which users are currently in the conversation room (active in chat)
  let usersInRoom = new Set<string>();
  try {
    const io = getIO();
    const sockets = await io.in(`conversation:${conversationId}`).fetchSockets();
    for (const s of sockets) {
      const uid = (s as any).userId as string | undefined;
      if (uid) usersInRoom.add(uid);
    }
  } catch {
    // Socket may not be initialized; notify everyone
  }

  // Determine notification body
  let body = content;
  if (options?.audioUrl) {
    body = 'Sent a voice message';
  } else if (options?.imageUrl && !content) {
    body = 'Sent an image';
  } else if (options?.imageUrl && content) {
    body = content;
  }

  // Truncate long messages for notification preview
  if (body.length > 100) {
    body = body.substring(0, 97) + '...';
  }

  for (const participant of participants) {
    // Skip notification if the user is currently viewing this conversation
    if (usersInRoom.has(participant.userId)) continue;

    // Create in-app notification (also emits socket event)
    createNotification({
      userId: participant.userId,
      type: 'chat_message',
      title: senderName,
      body,
      data: { conversationId, senderId },
    }).catch((err) => {
      logger.error({ err, userId: participant.userId }, 'Failed to create chat notification');
    });

    // Send FCM push notification
    sendPushToUser(participant.userId, {
      title: senderName,
      body,
      data: {
        type: 'chat_message',
        conversationId,
        senderId,
      },
    }).catch((err) => {
      logger.error({ err, userId: participant.userId }, 'Failed to send chat push notification');
    });
  }
}
