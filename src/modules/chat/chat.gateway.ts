import { Server, Socket } from 'socket.io';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { moderateContent } from '../safety/moderation.service';
import * as chatService from './chat.service';
import { formatMessagePayload } from './chat.utils';
import { notifyChatMessage } from '../notification/notification.service';

const VALID_EMOJIS = ['thumbsup', 'heart', 'laugh', 'wow', 'sad', 'pray'];

/**
 * Register all chat-related Socket.io event handlers on a connected socket.
 */
export function registerChatHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

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

      socket.join(`conversation:${conversationId}`);
      logger.info({ userId, conversationId, socketId: socket.id }, 'User joined conversation room');

      socket.emit('chat:joined', { conversationId });
    } catch (error) {
      logger.error({ error, userId }, 'Error joining conversation');
      socket.emit('chat:error', { message: 'Failed to join conversation' });
    }
  });

  /**
   * chat:message - Send a message: moderate content, persist, and broadcast to room.
   */
  socket.on('chat:message', async (data: { conversationId: string; content: string; replyToId?: string }) => {
    try {
      const { conversationId, content, replyToId } = data;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        socket.emit('chat:error', { message: 'Message content is required' });
        return;
      }

      if (content.length > 2000) {
        socket.emit('chat:error', { message: 'Message exceeds maximum length of 2000 characters' });
        return;
      }

      // Moderate content before saving
      let cleanedContent = content;
      try {
        const moderationResult = await moderateContent(content);
        if (moderationResult.flagged) {
          socket.emit('chat:error', { message: 'Message contains inappropriate content' });
          return;
        }
        cleanedContent = moderationResult.cleaned;
      } catch (moderationError) {
        logger.warn({ moderationError, userId, conversationId }, 'Content moderation failed, proceeding with original content');
      }

      // Save the message via the service
      const message = await chatService.sendMessage(conversationId, userId, cleanedContent, { replyToId });

      // Broadcast the message to all participants in the room
      io.to(`conversation:${conversationId}`).emit('chat:message', formatMessagePayload(message, conversationId));

      // Notify other participants (in-app + push)
      notifyChatMessage(
        conversationId,
        userId,
        message.sender.displayName,
        message.content,
        { imageUrl: message.imageUrl ?? undefined, audioUrl: message.audioUrl ?? undefined },
      ).catch(() => {});

      logger.debug({ conversationId, userId, messageId: message.id }, 'Message broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error sending message');
      const errorMessage = error?.statusCode ? error.message : 'Failed to send message';
      socket.emit('chat:error', { message: errorMessage });
    }
  });

  /**
   * chat:edit - Edit a message and broadcast to room.
   */
  socket.on('chat:edit', async (data: { messageId: string; content: string }) => {
    try {
      const { messageId, content } = data;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        socket.emit('chat:error', { message: 'Message content is required' });
        return;
      }

      if (content.length > 2000) {
        socket.emit('chat:error', { message: 'Message exceeds maximum length of 2000 characters' });
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
      const errorMessage = error?.statusCode ? error.message : 'Failed to edit message';
      socket.emit('chat:error', { message: errorMessage });
    }
  });

  /**
   * chat:delete - Delete a message and broadcast to room.
   */
  socket.on('chat:delete', async (data: { messageId: string }) => {
    try {
      const { messageId } = data;

      const message = await chatService.deleteMessage(messageId, userId);

      io.to(`conversation:${message.conversationId}`).emit('chat:deleted', {
        messageId: message.id,
        deletedAt: message.deletedAt,
      });

      logger.debug({ messageId, userId }, 'Delete broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error deleting message');
      const errorMessage = error?.statusCode ? error.message : 'Failed to delete message';
      socket.emit('chat:error', { message: errorMessage });
    }
  });

  /**
   * chat:react - Toggle a reaction and broadcast to room.
   */
  socket.on('chat:react', async (data: { messageId: string; emoji: string }) => {
    try {
      const { messageId, emoji } = data;

      if (!VALID_EMOJIS.includes(emoji)) {
        socket.emit('chat:error', { message: 'Invalid emoji' });
        return;
      }

      const result = await chatService.toggleReaction(messageId, userId, emoji);

      // Get the conversation ID from the message
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { conversationId: true },
      });

      if (message) {
        io.to(`conversation:${message.conversationId}`).emit('chat:reacted', {
          messageId: result.messageId,
          userId: result.userId,
          emoji: result.emoji,
          action: result.action,
          displayName: (result as any).displayName,
        });
      }

      logger.debug({ messageId, userId, emoji, action: result.action }, 'Reaction broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error toggling reaction');
      const errorMessage = error?.statusCode ? error.message : 'Failed to toggle reaction';
      socket.emit('chat:error', { message: errorMessage });
    }
  });

  /**
   * chat:delivered - Acknowledge message delivery and notify the sender.
   */
  socket.on('chat:delivered', async (data: { messageId: string; conversationId: string }) => {
    try {
      const { messageId, conversationId } = data;

      // Broadcast to room so the sender sees double grey ticks
      socket.to(`conversation:${conversationId}`).emit('chat:delivered', {
        messageId,
      });

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
      await chatService.markConversationAsRead(conversationId, userId);

      socket.to(`conversation:${conversationId}`).emit('chat:read', {
        conversationId,
        userId,
      });

      logger.debug({ conversationId, userId }, 'Read receipt broadcast');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error marking as read');
    }
  });

  /**
   * chat:typing - Broadcast typing indicator to the room (excluding sender).
   */
  socket.on('chat:typing', (data: { conversationId: string }) => {
    try {
      const { conversationId } = data;

      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        conversationId,
        userId,
      });
    } catch (error) {
      logger.error({ error, userId }, 'Error broadcasting typing indicator');
    }
  });

  /**
   * chat:leave - End the conversation, notify the room, and leave the socket room.
   */
  socket.on('chat:leave', async (data: { conversationId: string }) => {
    try {
      const { conversationId } = data;

      await chatService.endConversation(conversationId, userId);

      io.to(`conversation:${conversationId}`).emit('chat:ended', {
        conversationId,
        endedBy: userId,
      });

      socket.leave(`conversation:${conversationId}`);
      logger.info({ userId, conversationId, socketId: socket.id }, 'User left conversation room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error leaving conversation');
      const errorMessage = error?.statusCode ? error.message : 'Failed to leave conversation';
      socket.emit('chat:error', { message: errorMessage });
    }
  });
}
