import { Prisma } from '@prisma/client';
import * as admin from 'firebase-admin';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { getFirebaseApp } from '../../config/firebase';
import { sendVoipPush } from '../../config/apns';
import { logger } from '../../shared/logger';
import {
  buildCallPayload,
  buildMessagePayload,
  buildVoiceNotePayload,
} from './fcm-payload.builder';

export async function getNotifications(userId: string) {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // Enrich notifications with sender's isVerified status
  const senderIds = new Set<string>();
  for (const n of notifications) {
    const data = n.data as Record<string, unknown> | null;
    const senderId = data?.['senderId'] as string | undefined;
    const uid = data?.['userId'] as string | undefined;
    if (senderId) senderIds.add(senderId);
    else if (uid) senderIds.add(uid);
  }

  if (senderIds.size > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: [...senderIds] } },
      select: { id: true, isVerified: true },
    });
    const verifiedMap = new Map(users.map((u) => [u.id, u.isVerified]));

    return notifications.map((n) => {
      const data = (n.data as Record<string, unknown>) ?? {};
      const senderId = (data.senderId ?? data.userId) as string | undefined;
      if (senderId && verifiedMap.has(senderId)) {
        return { ...n, data: { ...data, isVerified: verifiedMap.get(senderId) ?? false } };
      }
      return n;
    });
  }

  return notifications;
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
      type: { in: ['CHAT_MESSAGE', 'VOICE_NOTE'] },
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
  type: 'CHAT_MESSAGE' | 'VOICE_NOTE' | 'NEW_FOLLOWER' | 'PROFILE_LIKED' | 'MATCH_FOUND' | 'STORY_GIFT' | 'STORY_LIKED' | 'MISSED_CALL' | 'SYSTEM' | 'POST_LIKED' | 'POST_COMMENTED' | 'NEW_POST';
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
 * Send an FCM multicast with retry (up to 3 attempts with exponential backoff).
 */
async function sendFcmWithRetry(
  message: admin.messaging.MulticastMessage,
  tokens: { token: string }[],
  userId: string,
  label: string,
  maxRetries = 2,
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      await cleanupInvalidFcmTokens(tokens, response, userId);
      return;
    } catch (err: any) {
      const isRetryable = err?.code === 'messaging/internal-error' ||
        err?.code === 'messaging/server-unavailable' ||
        err?.code === 'UNAVAILABLE';
      if (!isRetryable || attempt === maxRetries) {
        logger.error({ err, userId, attempt }, `Failed to send ${label} (final)`);
        return;
      }
      const delay = 1000 * Math.pow(2, attempt); // 1s, 2s
      logger.warn({ userId, attempt, delay }, `FCM ${label} failed, retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
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

  // Build alert title/body for iOS (APNS) display.
  const notifTitle = data.senderName || data.callerName || 'Yomeet';
  const notifBody =
    data.audioUrl ? 'Sent a voice message' : data.content || 'New message';

  // Android: data-only (no notification payload) so the native
  // YomeetFirebaseMessagingService ALWAYS handles display — this ensures
  // proper lock-screen visibility, screen wake, sound, and heads-up.
  // Including android.notification causes the OS to auto-display a basic
  // notification that doesn't wake the screen or show on lock screen.
  const message: admin.messaging.MulticastMessage = {
    tokens: tokens.map((t) => t.token),
    data,
    android: {
      priority: 'high',
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
      },
      payload: {
        aps: {
          alert: { title: notifTitle, body: notifBody },
          sound: 'default',
          'content-available': 1,
          'mutable-content': 1,
        },
      },
    },
  };

  await sendFcmWithRetry(message, tokens, userId, 'data push');
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
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
      },
      payload: {
        aps: {
          alert: {
            title: payload.title,
            body: payload.body,
          },
          sound: 'default',
          badge: 1,
          'content-available': 1,
          'mutable-content': 1,
        },
      },
    },
  };

  await sendFcmWithRetry(message, tokens, userId, 'alert push');
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
    isGroup?: boolean;
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
      // iOS devices with FCM token — include alert + sound so the notification is visible
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: {
            alert: { title: payload.callerName, body: payload.isGroup ? `Incoming group ${payload.callType === 'VIDEO' ? 'video' : 'audio'} call` : 'Incoming call' },
            sound: 'default',
            'content-available': 1,
          },
        },
      },
    };

    await sendFcmWithRetry(message, fcmTokens, userId, 'call push');
  }

  // Send iOS VoIP push via APNs (PushKit → CallKit)
  const voipTokens = await prisma.voipToken.findMany({
    where: { userId },
    select: { token: true },
  });

  if (voipTokens.length > 0) {
    const voipPayload = {
      callId: payload.callId,
      conversationId: payload.conversationId,
      callType: payload.callType,
      callerId: payload.callerId,
      callerName: payload.callerName,
      callerAvatar: payload.callerAvatar ?? null,
      isGroup: String(payload.isGroup ?? false),
    };

    for (const { token } of voipTokens) {
      sendVoipPush(token, voipPayload)
        .then((result) => {
          if (result.unregistered) {
            prisma.voipToken.deleteMany({ where: { token } }).catch((err) => {
              logger.error({ err, token }, 'Failed to delete unregistered VoIP token');
            });
          }
        })
        .catch((err) => {
          logger.error({ err, userId, callId: payload.callId }, 'Failed to send VoIP push');
        });
    }
  }
}

/**
 * Send a missed call notification to a user.
 * Creates an in-app notification and sends a push notification.
 */
export async function sendMissedCallNotification(
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
  const isVideo = payload.callType === 'VIDEO';
  const body = isVideo
    ? `Missed video call from ${payload.callerName}`
    : `Missed call from ${payload.callerName}`;

  // Create in-app notification (also emits notification:new socket event)
  createNotification({
    userId,
    type: 'MISSED_CALL',
    title: payload.callerName,
    body,
    imageUrl: payload.callerAvatar ?? undefined,
    data: {
      callId: payload.callId,
      conversationId: payload.conversationId,
      callType: payload.callType,
      callerId: payload.callerId,
      callerAvatar: payload.callerAvatar ?? null,
    },
  }).catch((err) => {
    logger.error({ err, userId }, 'Failed to create missed call notification');
  });

  // Send FCM push notification
  sendPushToUser(userId, {
    title: payload.callerName,
    body,
    imageUrl: payload.callerAvatar ?? undefined,
    data: {
      type: 'missed_call',
      callId: payload.callId,
      conversationId: payload.conversationId,
      callType: payload.callType,
      callerId: payload.callerId,
      callerName: payload.callerName,
      callerAvatar: payload.callerAvatar ?? '',
    },
  }).catch((err) => {
    logger.error({ err, userId }, 'Failed to send missed call push notification');
  });
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
    select: { userId: true, isMuted: true },
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

  // Fetch sender's avatar and verification status for notification display
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { avatarUrl: true, isVerified: true },
  });
  const senderAvatarUrl = sender?.avatarUrl ?? undefined;
  const senderIsVerified = sender?.isVerified ?? false;

  for (const participant of participants) {
    const isInRoom = usersInRoom.has(participant.userId);

    // Always create in-app notification (emits notification:new socket event)
    // so the notification bell badge updates even if the user just left the
    // chat room and the leave event hasn't been processed yet.
    createNotification({
      userId: participant.userId,
      type: isVoiceNote ? 'VOICE_NOTE' : 'CHAT_MESSAGE',
      title: senderName,
      body,
      imageUrl: senderAvatarUrl,
      data: {
        conversationId,
        senderId,
        senderAvatarUrl: senderAvatarUrl ?? null,
        isVerified: senderIsVerified,
        ...(options?.audioUrl ? { audioUrl: options.audioUrl } : {}),
        ...(options?.audioDuration !== undefined ? { audioDuration: options.audioDuration } : {}),
      },
    }).catch((err) => {
      logger.error({ err, userId: participant.userId }, 'Failed to create chat notification');
    });

    // Only send FCM push if:
    // 1. User is NOT currently viewing this conversation
    // 2. User has NOT muted this conversation
    if (!isInRoom && !participant.isMuted) {
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
}
