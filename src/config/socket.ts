import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { env } from './env';
import { logger } from '../shared/logger';
import { verifyAccessToken } from '../modules/auth/auth.utils';
import { setOnline, setOffline } from '../modules/user/user.service';
import { checkBanStatus } from '../modules/safety/safety.service';
import { prisma } from './database';

let io: Server;

// ── Per-user socket event rate limiting ─────────────────────────────────
// Sliding window: max events per window per user.
const SOCKET_RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const SOCKET_RATE_LIMIT_MAX = 50;           // 50 events per window

const userEventCounts = new Map<string, { count: number; resetAt: number }>();

// ── Foreground presence (per-socket) ────────────────────────────────────
// Implemented as Socket.IO rooms so the state is shared across all server
// instances via the Redis adapter — an in-memory Map only knows about the
// foreground sockets connected to *this* instance, which silently breaks
// the call-push gate as soon as Render scales beyond a single worker.
//
// Sockets join `fg:<userId>` on `presence:foreground` and leave on
// `presence:background`. Disconnects auto-leave all rooms, so no explicit
// cleanup is needed.
function foregroundRoom(userId: string): string {
  return `fg:${userId}`;
}

/** True if the user has at least one foregrounded device right now. */
export async function isUserForeground(userId: string): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(foregroundRoom(userId)).fetchSockets();
  return sockets.length > 0;
}

/** Returns true if the event should be allowed, false if rate-limited. */
function checkSocketRateLimit(userId: string): boolean {
  const now = Date.now();
  let entry = userEventCounts.get(userId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + SOCKET_RATE_LIMIT_WINDOW_MS };
    userEventCounts.set(userId, entry);
    return true;
  }
  entry.count++;
  if (entry.count > SOCKET_RATE_LIMIT_MAX) {
    return false;
  }
  return true;
}

// Clean up stale entries every 60 seconds to prevent memory leak.
const _socketCleanup = setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of userEventCounts) {
    if (now >= entry.resetAt) userEventCounts.delete(uid);
  }
}, 60_000);
_socketCleanup.unref();

export async function initializeSocket(httpServer: HttpServer): Promise<Server> {
  const corsOrigin = env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim());

  io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Use Redis adapter for multi-instance support when REDIS_URL is configured
  if (env.REDIS_URL) {
    let pubClient: ReturnType<typeof createClient> | null = null;
    let subClient: ReturnType<typeof createClient> | null = null;
    try {
      pubClient = createClient({ url: env.REDIS_URL });
      subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.IO Redis adapter enabled');
    } catch (err) {
      // Clean up connections on failure
      await pubClient?.disconnect().catch(() => {});
      await subClient?.disconnect().catch(() => {});
      logger.warn({ err }, 'Failed to connect Socket.IO Redis adapter, using in-memory');
    }
  }

  // Auth middleware
  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return next(new Error('Authentication required'));
      }
      const payload = verifyAccessToken(token);
      // Check if user is banned before allowing socket connection
      const ban = await checkBanStatus(payload.userId);
      if (ban.banned) {
        return next(new Error('Account suspended'));
      }
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

    // Per-event rate limiting — drops events that exceed the threshold
    socket.use((packet, next) => {
      if (!checkSocketRateLimit(userId)) {
        const eventName = packet[0];
        logger.warn({ userId, event: eventName }, 'Socket event rate-limited');
        return next(new Error('Rate limit exceeded'));
      }
      next();
    });

    // Set user online
    try {
      await setOnline(userId);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { hideOnlineStatus: true },
      });
      if (!user?.hideOnlineStatus) {
        io.emit('user:online', { userId });
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to set user online');
    }

    // Foreground presence — Flutter sends these on AppLifecycleState.resumed
    // and AppLifecycleState.paused. Used by the call gateway to skip push
    // notifications when the in-app overlay can handle the ring directly.
    socket.on('presence:foreground', () => socket.join(foregroundRoom(userId)));
    socket.on('presence:background', () => socket.leave(foregroundRoom(userId)));

    socket.on('disconnect', async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected');

      // Check if user has other active sockets before marking offline
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      if (sockets.length === 0) {
        try {
          await setOffline(userId);
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { hideOnlineStatus: true },
          });
          if (!user?.hideOnlineStatus) {
            io.emit('user:offline', {
              userId,
              lastSeenAt: new Date().toISOString(),
            });
          }
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
