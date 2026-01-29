import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { logger } from '../shared/logger';
import { verifyAccessToken } from '../modules/auth/auth.utils';
import { setOnline, setOffline } from '../modules/user/user.service';

let io: Server;

export function initializeSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return next(new Error('Authentication required'));
      }
      const payload = verifyAccessToken(token);
      (socket as any).userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const userId = (socket as any).userId;
    socket.join(`user:${userId}`);
    logger.info({ userId, socketId: socket.id }, 'Socket connected');

    // Set user online
    try {
      await setOnline(userId);
      socket.broadcast.emit('user:online', { userId });
    } catch (err) {
      logger.error({ err, userId }, 'Failed to set user online');
    }

    socket.on('disconnect', async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected');

      // Check if user has other active sockets before marking offline
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      if (sockets.length === 0) {
        try {
          await setOffline(userId);
          socket.broadcast.emit('user:offline', {
            userId,
            lastSeenAt: new Date().toISOString(),
          });
        } catch (err) {
          logger.error({ err, userId }, 'Failed to set user offline');
        }
      }
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}
