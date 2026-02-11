import { Prisma } from '@prisma/client';
import * as admin from 'firebase-admin';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { getFirebaseApp } from '../../config/firebase';
import { logger } from '../../shared/logger';
import {
  buildCallPayload,
  buildMessagePayload,
  buildVoiceNotePayload,
} from './fcm-payload.builder';

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
  // Mark both chat_message and voice_note notifications for this conversation
  await prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
      type: { in: ['chat_message', 'voice_note'] },
      data: { path: ['conversationId'], equals: conversationId },
    },
    data: { isRead: true },
  });
}

export async function deleteNotification(userId: string, notificationId: string) {
  await prisma.notification.deleteMany({
    where: { id: notificationId, userId },
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

// ─── VoIP Token Management (iOS) ─────────────────────────

export async function registerVoipToken(userId: string, token: string) {
  await prisma.voipToken.upsert({
    where: { token },
    create: { userId, token, platform: 'ios' },
    update: { userId },
  });
}

export async function removeVoipToken(token: string) {
  await prisma.voipToken.deleteMany({
    where: { token },
  });
}

/**
 * Clean up invalid FCM tokens after a multicast send.
 */
async function cleanupInvalidFcmTokens(
  tokens: { token: string }[],
  response: admin.messaging.BatchResponse,
  userId: string
) {
  if (response.failureCount === 0) return;

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

/**
 * Send a data-only push notification via FCM to all devices registered for a user.
 * Data-only messages give the client full control over notification display.
 */
async function sendDataPushToUser(userId: string, data: Record<string, string>) {
  const app = getFirebaseApp();
  if (!app) return;

  const tokens = await prisma.fcmToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (tokens.length === 0) return;

  // Build iOS alert from data fields so the notification is visible on iOS
  // (data-only silent pushes are not displayed by the OS).
  const iosTitle = data.senderName || data.callerName || 'Yomeet';
  const iosBody =
    data.audioUrl ? 'Sent a voice message' : data.content || 'New message';

  const message: admin.messaging.MulticastMessage = {
    tokens: tokens.map((t) => t.token),
    data,
    android: {
      priority: 'high',
    },
    apns: {
      payload: {
        aps: {
          alert: { title: iosTitle, body: iosBody },
          sound: 'default',
          'mutable-content': 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    await cleanupInvalidFcmTokens(tokens, response, userId);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to send FCM data push notification');
  }
}

/**
 * Send a push notification via FCM to all devices registered for a user.
 * This version includes a notification payload for backwards compatibility.
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
    data: payload.data ?? {},
    android: {
      priority: 'high',
      notification: {
        channelId: 'yomeet_messages',
        sound: 'default',
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      },
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title: payload.title,
            body: payload.body,
          },
          sound: 'default',
          badge: 1,
          'mutable-content': 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    await cleanupInvalidFcmTokens(tokens, response, userId);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to send FCM push notification');
  }
}

/**
 * Send a high-priority call push notification.
 * On iOS, this triggers through VoIP push (APNs) for CallKit integration.
 * On Android, this sends a high-priority FCM data message.
 */
export async function sendCallPush(
  userId: string,
  payload: {
    callId: string;
    conversationId: string;
    callType: 'AUDIO' | 'VIDEO';
    callerId: string;
    callerName: string;
    callerAvatar?: string | null;
  }
) {
  const app = getFirebaseApp();
  if (!app) return;

  const fcmData = buildCallPayload(payload);

  // Send to Android devices via FCM
  const fcmTokens = await prisma.fcmToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (fcmTokens.length > 0) {
    const message: admin.messaging.MulticastMessage = {
      tokens: fcmTokens.map((t) => t.token),
      data: fcmData,
      android: {
        priority: 'high',
        ttl: 60000, // 60 seconds
      },
      // iOS devices with FCM token will also receive this as a fallback
      apns: {
        payload: {
          aps: {
            'content-available': 1,
          },
        },
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      await cleanupInvalidFcmTokens(fcmTokens, response, userId);
    } catch (err) {
      logger.error({ err, userId }, 'Failed to send call FCM push');
    }
  }

  // Note: iOS VoIP push (PushKit) requires a separate APNs connection
  // which should be handled through a dedicated VoIP push provider
  // For now, log that VoIP tokens exist for future implementation
  const voipTokens = await prisma.voipToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (voipTokens.length > 0) {
    logger.info(
      { userId, tokenCount: voipTokens.length, callId: payload.callId },
      'VoIP tokens found - iOS VoIP push should be sent via APNs'
    );
    // TODO: Implement APNs VoIP push using node-apn or similar library
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
  options?: {
    messageId?: string;
    imageUrl?: string;
    audioUrl?: string;
    audioDuration?: number;
  },
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
  const isVoiceNote = !!options?.audioUrl;
  let body = content;
  if (isVoiceNote) {
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

  // Fetch sender's avatar for notification display
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { avatarUrl: true },
  });
  const senderAvatarUrl = sender?.avatarUrl ?? undefined;

  for (const participant of participants) {
    // Skip notification if the user is currently viewing this conversation
    if (usersInRoom.has(participant.userId)) continue;

    // Create in-app notification (also emits socket event)
    createNotification({
      userId: participant.userId,
      type: isVoiceNote ? 'voice_note' : 'chat_message',
      title: senderName,
      body,
      imageUrl: senderAvatarUrl,
      data: {
        conversationId,
        senderId,
        senderAvatarUrl: senderAvatarUrl ?? null,
        ...(options?.audioUrl ? { audioUrl: options.audioUrl } : {}),
        ...(options?.audioDuration !== undefined ? { audioDuration: options.audioDuration } : {}),
      },
    }).catch((err) => {
      logger.error({ err, userId: participant.userId }, 'Failed to create chat notification');
    });

    // Send FCM push notification - use data-only for rich notification support
    if (isVoiceNote && options?.audioUrl) {
      // Voice note: send data-only for in-notification playback
      const voiceNotePayload = buildVoiceNotePayload({
        messageId: options.messageId ?? '',
        conversationId,
        senderId,
        senderName,
        senderAvatar: senderAvatarUrl,
        audioUrl: options.audioUrl,
        audioDuration: options.audioDuration ?? 0,
      });
      sendDataPushToUser(participant.userId, voiceNotePayload).catch((err) => {
        logger.error({ err, userId: participant.userId }, 'Failed to send voice note push');
      });
    } else {
      // Text/image message: data-only so the client controls notification display
      const messagePayload = buildMessagePayload({
        messageId: options?.messageId,
        conversationId,
        senderId,
        senderName,
        senderAvatar: senderAvatarUrl,
        content: body,
        imageUrl: options?.imageUrl,
      });
      sendDataPushToUser(participant.userId, messagePayload).catch((err) => {
        logger.error({ err, userId: participant.userId }, 'Failed to send chat push notification');
      });
    }
  }
}
