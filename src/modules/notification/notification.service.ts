import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';

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
