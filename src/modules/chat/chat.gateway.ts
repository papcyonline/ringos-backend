import { Server, Socket } from 'socket.io';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import * as chatService from './chat.service';
import { broadcastAndNotifyMessage } from './chat.utils';
import { notifyChatMessage, markConversationNotificationsAsRead } from '../notification/notification.service';

/** Extract a user-facing error message from a caught error. */
function extractErrorMessage(error: any, fallback: string): string {
  return error?.statusCode ? error.message : fallback;
}

function validateMessageContent(content: unknown): { valid: true } | { valid: false; error: string } {
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { valid: false, error: 'Message content is required' };
  }
  if (content.length > 2000) {
    return { valid: false, error: 'Message exceeds maximum length of 2000 characters' };
  }
  return { valid: true };
}

/**
 * Register all chat-related Socket.io event handlers on a connected socket.
 */
/**
 * On authenticated connect, mark all messages that arrived while this user was
 * offline as "delivered" across *every* conversation they participate in.
 * Without this, grey-double-ticks would only appear when the user opens each
 * specific chat, which doesn't match WhatsApp's device-level delivery model.
 */
async function sweepDeliveredOnConnect(io: Server, userId: string): Promise<void> {
  try {
    // Find all active participations + their current lastDeliveredAt.
    const participations = await prisma.conversationParticipant.findMany({
      where: { userId, leftAt: null },
      select: { conversationId: true, lastDeliveredAt: true },
    });
    if (participations.length === 0) return;

    const convIds = participations.map((p) => p.conversationId);

    // Latest message per conversation from someone else — the high-water mark.
    const latest = await prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: convIds },
        senderId: { not: userId },
        deletedAt: null,
      },
      _max: { createdAt: true },
    });

    const now = new Date();
    const bumped: { conversationId: string; previousAt: Date | null }[] = [];
    for (const row of latest) {
      const latestAt = row._max.createdAt;
      if (!latestAt) continue;
      const existing = participations.find((p) => p.conversationId === row.conversationId);
      if (existing && (existing.lastDeliveredAt == null || existing.lastDeliveredAt < latestAt)) {
        bumped.push({ conversationId: row.conversationId, previousAt: existing.lastDeliveredAt ?? null });
      }
    }
    if (bumped.length === 0) return;

    // One bulk update — cap at `now` so we never record a future timestamp.
    await prisma.conversationParticipant.updateMany({
      where: { userId, conversationId: { in: bumped.map((b) => b.conversationId) } },
      data: { lastDeliveredAt: now },
    });

    // For each bumped conversation, emit `chat:delivered` to every sender's
    // personal room — that's the only way a sender whose chat screen is
    // closed will see their sent→delivered tick update, since they aren't in
    // the conversation room anymore.
    for (const b of bumped) {
      const senders = await prisma.message.findMany({
        where: {
          conversationId: b.conversationId,
          senderId: { not: userId },
          deletedAt: null,
          ...(b.previousAt ? { createdAt: { gt: b.previousAt } } : {}),
        },
        distinct: ['senderId'],
        select: { senderId: true },
      });
      for (const s of senders) {
        io.to(`user:${s.senderId}`).emit('chat:delivered', {
          conversationId: b.conversationId,
        });
      }
    }

    logger.debug({ userId, count: bumped.length }, 'Delivered sweep on connect');
  } catch (err) {
    logger.error({ err, userId }, 'Delivered sweep failed');
  }
}

export function registerChatHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  // Fire the delivered sweep once per socket connection (best-effort).
  sweepDeliveredOnConnect(io, userId).catch(() => {});

  /**
   * chat:join - Join a conversation room after verifying participation.
   */
  socket.on('chat:join', async (data: { conversationId: string }) => {
    try {
      const { conversationId } = data;

      const participant = await prisma.conversationParticipant.findUnique({
        where: {
          conversationId_userId: { conversationId, userId },
        },
      });

      if (!participant) {
        socket.emit('chat:error', { message: 'You are not a participant in this conversation' });
        return;
      }

      if (participant.leftAt !== null) {
        socket.emit('chat:error', { message: 'You have left this conversation' });
        return;
      }

      socket.join(`conversation:${conversationId}`);
      logger.info({ userId, conversationId, socketId: socket.id }, 'User joined conversation room');

      socket.emit('chat:joined', { conversationId });

      // Opening the chat means the user has seen these messages — clear their
      // private notifications for this conversation now, regardless of whether
      // they ever interact (which is what would trigger chat:read and the
      // sender-visible read receipt). lastReadAt is intentionally NOT touched
      // here so read-receipt timing stays controlled by chat:read.
      markConversationNotificationsAsRead(userId, conversationId)
        .then(() => {
          io.to(`user:${userId}`).emit('notification:read-conversation', { conversationId });
        })
        .catch((err) => {
          logger.error({ err, userId, conversationId }, 'Failed to clear notifications on chat:join');
        });
    } catch (error) {
      logger.error({ error, userId }, 'Error joining conversation');
      socket.emit('chat:error', { message: 'Failed to join conversation' });
    }
  });

  /**
   * chat:sync - Return messages newer than sinceMessageId so the client can
   * backfill anything missed while the socket was disconnected or the screen
   * was off. Replies with `chat:synced` carrying { conversationId, messages }.
   */
  socket.on('chat:sync', async (data: { conversationId: string; sinceMessageId?: string }) => {
    try {
      const { conversationId, sinceMessageId } = data || ({} as any);
      if (!conversationId) {
        socket.emit('chat:error', { message: 'conversationId is required' });
        return;
      }

      const result = await chatService.getMessagesSince(conversationId, userId, sinceMessageId, 200);

      socket.emit('chat:synced', {
        conversationId,
        sinceMessageId: sinceMessageId ?? null,
        messages: result.messages,
        hasMore: result.hasMore,
        nextSinceId: result.nextSinceId,
        sinceNotFound: result.sinceNotFound,
      });
      logger.debug(
        { userId, conversationId, count: result.messages.length, sinceMessageId, hasMore: result.hasMore, sinceNotFound: result.sinceNotFound },
        'chat:sync replied',
      );
    } catch (error: any) {
      logger.error({ error, userId }, 'Error syncing messages');
      socket.emit('chat:error', { message: extractErrorMessage(error, 'Failed to sync messages') });
    }
  });

  /**
   * chat:message - Send a message: moderate content, persist, and broadcast to room.
   */
  socket.on('chat:message', async (data: { conversationId: string; content: string; replyToId?: string; metadata?: Record<string, any> }) => {
    try {
      const { conversationId, content, replyToId, metadata } = data;

      const validation = validateMessageContent(content);
      if (!validation.valid) {
        socket.emit('chat:error', { message: validation.error });
        return;
      }

      const cleanedContent = content;

      // Save the message via the service
      const message = await chatService.sendMessage(conversationId, userId, cleanedContent, { replyToId, metadata });

      broadcastAndNotifyMessage(message, conversationId, userId);

      logger.debug({ conversationId, userId, messageId: message.id }, 'Message broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error sending message');
      socket.emit('chat:error', { message: extractErrorMessage(error, 'Failed to send message') });
    }
  });

  /**
   * chat:edit - Edit a message and broadcast to room.
   */
  socket.on('chat:edit', async (data: { messageId: string; content: string }) => {
    try {
      const { messageId, content } = data;

      const validation = validateMessageContent(content);
      if (!validation.valid) {
        socket.emit('chat:error', { message: validation.error });
        return;
      }

      const message = await chatService.editMessage(messageId, userId, content);

      io.to(`conversation:${message.conversationId}`).emit('chat:edited', {
        messageId: message.id,
        content: message.content,
        editedAt: message.editedAt,
      });

      logger.debug({ messageId, userId }, 'Edit broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error editing message');
      socket.emit('chat:error', { message: extractErrorMessage(error, 'Failed to edit message') });
    }
  });

  /**
   * chat:delete - Delete a message and broadcast to room.
   * Accepts optional `mode` — 'everyone' (default, soft delete with placeholder)
   * or 'unsend' (hard delete, no trace).
   */
  socket.on('chat:delete', async (data: { messageId: string; mode?: 'everyone' | 'unsend' }) => {
    try {
      const { messageId, mode = 'everyone' } = data;

      const message = await chatService.deleteMessage(messageId, userId, mode);
      const event = mode === 'unsend' ? 'chat:unsent' : 'chat:deleted';

      const payload = {
        messageId: message.id,
        conversationId: message.conversationId,
        deletedAt: (message as any).deletedAt ?? null,
      };
      io.to(`conversation:${message.conversationId}`).emit(event, payload);

      // Also emit to personal rooms so conversation list updates lastMessage.
      prisma.conversationParticipant.findMany({
        where: { conversationId: message.conversationId, leftAt: null },
        select: { userId: true },
      }).then((participants) => {
        for (const p of participants) {
          io.to(`user:${p.userId}`).emit(event, payload);
        }
      }).catch(() => {});

      logger.debug({ messageId, userId, mode }, `${event} broadcast`);
    } catch (error: any) {
      logger.error({ error, userId }, 'Error deleting message');
      socket.emit('chat:error', { message: extractErrorMessage(error, 'Failed to delete message') });
    }
  });

  /**
   * chat:react - Toggle a reaction and broadcast to room.
   */
  socket.on('chat:react', async (data: { messageId: string; emoji: string }) => {
    try {
      const { messageId, emoji } = data;

      if (!emoji || typeof emoji !== 'string' || emoji.length > 32) {
        socket.emit('chat:error', { message: 'Invalid emoji' });
        return;
      }

      const result = await chatService.toggleReaction(messageId, userId, emoji);

      io.to(`conversation:${result.conversationId}`).emit('chat:reacted', {
        messageId: result.messageId,
        userId: result.userId,
        emoji: result.emoji,
        action: result.action,
        displayName: (result as any).displayName,
      });

      logger.debug({ messageId, userId, emoji, action: result.action }, 'Reaction broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error toggling reaction');
      socket.emit('chat:error', { message: extractErrorMessage(error, 'Failed to toggle reaction') });
    }
  });

  /**
   * chat:delivered - Acknowledge message delivery and notify the sender.
   */
  socket.on('chat:delivered', async (data: { messageId: string; conversationId: string }) => {
    try {
      const { messageId, conversationId } = data;

      // Update lastDeliveredAt for this participant
      const now = new Date();
      await prisma.conversationParticipant.updateMany({
        where: { conversationId, userId },
        data: { lastDeliveredAt: now },
      });

      // Broadcast to conversation room
      socket.to(`conversation:${conversationId}`).emit('chat:delivered', {
        messageId,
        conversationId,
      });

      // Also emit to the message sender's personal room so they see
      // double grey ticks even if they left the chat screen.
      try {
        const msg = await prisma.message.findUnique({
          where: { id: messageId },
          select: { senderId: true },
        });
        if (msg && msg.senderId !== userId) {
          io.to(`user:${msg.senderId}`).emit('chat:delivered', { messageId, conversationId });
        }
      } catch { /* non-critical */ }

      logger.debug({ messageId, userId }, 'Delivery receipt broadcast');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error broadcasting delivery receipt');
    }
  });

  /**
   * chat:read - Mark conversation as read and notify the room.
   */
  socket.on('chat:read', async (data: { conversationId: string }) => {
    try {
      const { conversationId } = data;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { hideReadReceipts: true },
      });

      if (user?.hideReadReceipts) {
        // Privacy mode: clear the reader's own notifications (private state),
        // but don't update lastReadAt or broadcast — the sender stays in the dark.
        await markConversationNotificationsAsRead(userId, conversationId);
      } else {
        await chatService.markConversationAsRead(conversationId, userId);

        const readPayload = { conversationId, userId };

        // Broadcast to conversation room
        socket.to(`conversation:${conversationId}`).emit('chat:read', readPayload);

        // Also emit to all other participants' personal rooms so the
        // sender sees blue ticks even if they left the chat screen.
        try {
          const participants = await prisma.conversationParticipant.findMany({
            where: { conversationId, userId: { not: userId }, leftAt: null },
            select: { userId: true },
          });
          for (const p of participants) {
            io.to(`user:${p.userId}`).emit('chat:read', readPayload);
          }
        } catch { /* non-critical */ }
      }

      // Always sync the reader's own devices/screens so the notification inbox
      // reflects the new read state without requiring a manual refresh.
      io.to(`user:${userId}`).emit('notification:read-conversation', { conversationId });

      logger.debug({ conversationId, userId }, 'Read receipt processed');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error marking as read');
    }
  });

  /**
   * chat:typing - Broadcast typing/recording indicator to the room (excluding sender).
   * Auto-clears after 5 seconds if no follow-up typing event is received.
   */
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  socket.on('chat:typing', (data: { conversationId: string; activity?: string }) => {
    try {
      const { conversationId, activity } = data;

      // Only broadcast typing if the socket has joined the conversation room.
      // Without this, any logged-in user can spam typing events to any known
      // conversation id.
      const room = `conversation:${conversationId}`;
      if (!socket.rooms.has(room)) return;

      socket.to(room).emit('chat:typing', {
        conversationId,
        userId,
        activity: activity ?? 'typing',
      });

      // Clear previous timer for this conversation and set a new one
      const timerKey = conversationId;
      const existing = typingTimers.get(timerKey);
      if (existing) clearTimeout(existing);
      typingTimers.set(timerKey, setTimeout(() => {
        socket.to(`conversation:${conversationId}`).emit('chat:typing-stop', {
          conversationId,
          userId,
        });
        typingTimers.delete(timerKey);
      }, 5000));
    } catch (error) {
      logger.error({ error, userId }, 'Error broadcasting typing indicator');
    }
  });

  // Clean up typing timers on disconnect
  socket.on('disconnect', () => {
    for (const timer of typingTimers.values()) clearTimeout(timer);
    typingTimers.clear();
  });

  /**
   * chat:leave-room - Leave the socket room without ending the conversation.
   * Used when the user navigates away from the chat screen.
   */
  socket.on('chat:leave-room', (data: { conversationId: string }) => {
    try {
      const { conversationId } = data;
      socket.leave(`conversation:${conversationId}`);
      logger.debug({ userId, conversationId, socketId: socket.id }, 'User left conversation room (screen close)');
    } catch (error) {
      logger.error({ error, userId }, 'Error leaving conversation room');
    }
  });

  /**
   * chat:leave - End the conversation, notify the room, and leave the socket room.
   */
  socket.on('chat:leave', async (data: { conversationId: string }) => {
    try {
      const { conversationId } = data;

      const conversation = await chatService.endConversation(conversationId, userId);

      // For groups/channels, only this participant left — don't tell everyone
      // the conversation is over. Emit a distinct event so clients can refresh
      // their participants list but keep the chat open.
      if ((conversation as any)?.status === 'ENDED') {
        io.to(`conversation:${conversationId}`).emit('chat:ended', {
          conversationId,
          endedBy: userId,
        });
      } else {
        io.to(`conversation:${conversationId}`).emit('chat:member-left', {
          conversationId,
          userId,
        });
      }

      socket.leave(`conversation:${conversationId}`);
      logger.info({ userId, conversationId, socketId: socket.id }, 'User left conversation room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error leaving conversation');
      socket.emit('chat:error', { message: extractErrorMessage(error, 'Failed to leave conversation') });
    }
  });
}
