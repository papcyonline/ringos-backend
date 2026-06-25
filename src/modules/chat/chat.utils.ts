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
  // Pull participants AND the conversation's request state in parallel
  // so we can suppress real-time delivery to the recipient of a
  // PENDING request — they shouldn't see a banner or a chat-list row
  // until they explicitly accept.
  const [participants, convo] = await Promise.all([
    prisma.conversationParticipant.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true },
    }),
    prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { requestStatus: true, requestedById: true },
    }),
  ]);
  const isPending = convo?.requestStatus === 'PENDING';
  const senderUserId = convo?.requestedById ?? null;
  logger.info(
    { conversationId, participantCount: participants.length, isPending },
    'Emitting chat:list-update + chat:message to participant rooms',
  );
  for (const p of participants) {
    // For PENDING requests the recipient must NOT receive chat:list-update
    // or chat:message — those would surface a stranger's DM in the normal
    // inbox and pop a banner. Instead send a dedicated lightweight signal
    // so the Message Requests list can refresh live, without leaking the
    // request into the main inbox or firing a notification banner. The
    // sender still gets the full payload below so their own send echoes.
    if (isPending && p.userId !== senderUserId) {
      io.to(`user:${p.userId}`).emit('chat:request-update', { conversationId });
      continue;
    }
    // chat:list-update drives the chats-list lastMessage UI.
    io.to(`user:${p.userId}`).emit('chat:list-update', payload);
    // chat:message is also emitted to the participant's personal user room
    // as a belt-and-suspenders fallback against the conversation:${id} room
    // membership being briefly stale — e.g. after a socket reconnect when
    // chat:join hasn't been processed yet, or the user navigated away from
    // the chat screen but is still online. Without this, a sender whose
    // socket reconnected after a network drop never sees their own message
    // come back from a retry, even though the server saved it (the user
    // sees a "failed" state until they cold-restart the app and refetch).
    // Frontend dedupes by message id, so the duplicate emit is safe.
    io.to(`user:${p.userId}`).emit('chat:message', payload);
  }
}

/**
 * Format a Prisma message (with includes) into the Socket.IO broadcast payload.
 * Used by both the HTTP routes and the WebSocket gateway to avoid duplication.
 */
export function formatMessagePayload(message: any, conversationId: string) {
  return {
    id: message.id,
    // Echoed back so the client can reconcile its temp message by the
    // UUID it generated at compose time. Older clients ignore it.
    clientMsgId: message.clientMsgId ?? null,
    conversationId,
    senderId: message.senderId,
    senderName: message.sender.displayName,
    senderAvatar: message.sender.avatarUrl,
    content: message.content,
    imageUrl: message.imageUrl,
    imageUrls: message.imageUrls ?? [],
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
