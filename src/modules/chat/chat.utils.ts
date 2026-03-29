import { Server } from 'socket.io';
import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import { logger } from '../../shared/logger';
import { notifyChatMessage } from '../notification/notification.service';
import { translateMessage } from './translation.service';

/**
 * Shared utilities for the chat module.
 */

/**
 * Emit a `chat:list-update` event to each participant's personal `user:<id>`
 * room so the conversations-list screen updates in real-time even when the
 * user is NOT inside the specific conversation room.
 */
export async function emitToParticipantRooms(
  io: Server,
  conversationId: string,
  payload: any,
): Promise<void> {
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  logger.info({ conversationId, participantCount: participants.length }, 'Emitting chat:list-update to participant rooms');
  for (const p of participants) {
    io.to(`user:${p.userId}`).emit('chat:list-update', payload);
  }
}

/**
 * Format a Prisma message (with includes) into the Socket.IO broadcast payload.
 * Used by both the HTTP routes and the WebSocket gateway to avoid duplication.
 */
export function formatMessagePayload(message: any, conversationId: string) {
  return {
    id: message.id,
    conversationId,
    senderId: message.senderId,
    senderName: message.sender.displayName,
    senderAvatar: message.sender.avatarUrl,
    content: message.content,
    imageUrl: message.imageUrl,
    audioUrl: message.audioUrl,
    audioDuration: message.audioDuration,
    viewOnce: message.viewOnce,
    viewOnceOpened: message.viewOnceOpened,
    replyToId: message.replyToId,
    replyTo: message.replyTo
      ? {
          id: message.replyTo.id,
          content: message.replyTo.content,
          senderId: message.replyTo.senderId,
          senderName: message.replyTo.sender?.displayName ?? (message.replyTo as any).sender?.displayName,
        }
      : null,
    metadata: message.metadata,
    isPinned: message.isPinned ?? false,
    pinnedAt: message.pinnedAt,
    pinnedById: message.pinnedById,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    reactions: message.reactions.map((r: any) => ({
      emoji: r.emoji,
      userId: r.userId,
      displayName: r.user.displayName,
    })),
    createdAt: message.createdAt,
  };
}

/**
 * After a message is created, broadcast it to all relevant socket rooms,
 * send push notifications, and trigger background translation.
 * Shared by both REST routes and the socket gateway.
 */
export function broadcastAndNotifyMessage(
  message: any,
  conversationId: string,
  senderId: string,
): void {
  const io = getIO();
  const payload = formatMessagePayload(message, conversationId);

  // 1. Broadcast to conversation room (real-time chat view)
  io.to(`conversation:${conversationId}`).emit('chat:message', payload);

  // 2. Emit to each participant's personal room (conversation-list updates)
  emitToParticipantRooms(io, conversationId, payload).catch((err) => {
    logger.error({ err, conversationId }, 'Failed to emit to participant rooms');
  });

  // 3. Push + in-app notifications
  notifyChatMessage(
    conversationId,
    senderId,
    message.sender.displayName,
    message.content,
    {
      messageId: message.id,
      imageUrl: message.imageUrl ?? undefined,
      audioUrl: message.audioUrl ?? undefined,
      audioDuration: message.audioDuration ?? undefined,
    },
  ).catch((err) => {
    logger.error({ err, conversationId }, 'Failed to send chat notification');
  });

  // 4. Background translation
  if (message.content) {
    translateMessage(message.id, conversationId, message.content).catch(() => {});
  }
}
