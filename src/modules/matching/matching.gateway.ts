import { Server, Socket } from 'socket.io';
import { logger } from '../../shared/logger';
import * as matchingService from './matching.service';

export function registerMatchingHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  socket.on('matching:ready', async () => {
    try {
      // Get the user's active waiting request
      const request = await matchingService.getActiveRequest(userId);

      if (!request) {
        socket.emit('matching:error', { message: 'No active match request found' });
        return;
      }

      logger.info({ userId, requestId: request.id }, 'User signaled matching ready');

      // Attempt to find a match
      const result = await matchingService.attemptMatch(request);

      if (result) {
        const { conversation, matchedUserId, score } = result;

        // Notify the requesting user
        socket.emit('matching:found', {
          conversationId: conversation.id,
          participants: conversation.participants,
          score,
        });

        // Notify the matched user via their room
        io.to(`user:${matchedUserId}`).emit('matching:found', {
          conversationId: conversation.id,
          participants: conversation.participants,
          score,
        });

        logger.info(
          { userId, matchedUserId, conversationId: conversation.id },
          'Match found via gateway',
        );
      } else {
        // No match found yet; the client should retry or wait
        socket.emit('matching:waiting', {
          requestId: request.id,
          message: 'Still searching for a match',
        });
      }
    } catch (error) {
      logger.error({ userId, error }, 'Error during matching:ready handler');
      socket.emit('matching:error', { message: 'An error occurred while matching' });
    }
  });
}
