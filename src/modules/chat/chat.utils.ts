import { Server } from 'socket.io';
import { prisma } from '../../config/database';

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
  try {
    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true },
    });
    for (const p of participants) {
      io.to(`user:${p.userId}`).emit('chat:list-update', payload);
    }
  } catch {
    // Non-critical — conversation room broadcast already handled
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
