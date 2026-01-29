import { Server, Socket } from 'socket.io';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { moderateContent } from '../safety/moderation.service';
import * as chatService from './chat.service';

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
  socket.on('chat:message', async (data: { conversationId: string; content: string }) => {
    try {
      const { conversationId, content } = data;

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
      const message = await chatService.sendMessage(conversationId, userId, cleanedContent);

      // Broadcast the message to all participants in the room
      io.to(`conversation:${conversationId}`).emit('chat:message', {
        id: message.id,
        conversationId,
        senderId: message.senderId,
        senderName: message.sender.displayName,
        content: message.content,
        createdAt: message.createdAt,
      });

      logger.debug({ conversationId, userId, messageId: message.id }, 'Message broadcast to room');
    } catch (error: any) {
      logger.error({ error, userId }, 'Error sending message');
      const errorMessage = error?.statusCode ? error.message : 'Failed to send message';
      socket.emit('chat:error', { message: errorMessage });
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

      // Notify remaining participants
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
