import { Server, Socket } from 'socket.io';
import { logger } from '../../shared/logger';
import {
  createSpotlightLog,
  endSpotlightLog,
  getBlockedUserIds,
  buildBroadcasterList,
  findOrCreateConversation,
  areUsersBlocked,
  isUserInCall,
} from './spotlight.service';
import { createDirectCall } from '../call/call.gateway';
import { prisma } from '../../config/database';

// ─── Types ──────────────────────────────────────────────────

interface BroadcasterEntry {
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  note: string | null;
  isVerified: boolean;
  location: string | null;
  startedAt: Date;
  viewerCount: number;   // updated by broadcaster's Flutter app via spotlight:viewer-count
  logId: string;
  peakViewers: number;
  totalViewers: number;
  connectCount: number;
}

// ─── In-memory state ─────────────────────────────────────────

/** userId -> BroadcasterEntry */
export const liveBroadcasters = new Map<string, BroadcasterEntry>();

/** Grace period timers for disconnected broadcasters */
const disconnectGrace = new Map<string, ReturnType<typeof setTimeout>>();

/** Async guard: prevents double go-live while DB write is in-flight */
const pendingGoLive = new Set<string>();

/** Async guard: prevents two viewers connecting to the same broadcaster simultaneously */
const pendingConnect = new Set<string>();

const DISCONNECT_GRACE_MS = 10_000;

// ─── Handler registration ────────────────────────────────────

export function registerSpotlightHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  // ── Reconnection: cancel pending disconnect grace ──
  const pending = disconnectGrace.get(userId);
  if (pending) {
    clearTimeout(pending);
    disconnectGrace.delete(userId);
    if (liveBroadcasters.has(userId)) {
      socket.join('spotlight:live');
      logger.info({ userId }, 'Broadcaster reconnected during spotlight grace period');
    }
  }

  // ── spotlight:join-room ──
  socket.on('spotlight:join-room', () => {
    socket.join('spotlight:live');
  });

  // ── spotlight:leave-room ──
  socket.on('spotlight:leave-room', () => {
    socket.leave('spotlight:live');
  });

  // ── spotlight:go-live ──
  socket.on('spotlight:go-live', async (data: { note?: string }) => {
    try {
      if (data?.note != null && typeof data.note !== 'string') return;
      if (pendingGoLive.has(userId)) {
        socket.emit('spotlight:error', { message: 'Already going live, please wait' });
        return;
      }
      if (liveBroadcasters.has(userId)) {
        socket.emit('spotlight:error', { message: 'Already broadcasting' });
        return;
      }

      pendingGoLive.add(userId);
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true, avatarUrl: true, bio: true, isVerified: true, location: true },
        });
        if (!user) return;

        const logId = await createSpotlightLog(userId, data.note);

        const entry: BroadcasterEntry = {
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          bio: user.bio,
          note: data.note ?? null,
          isVerified: user.isVerified,
          location: user.location,
          startedAt: new Date(),
          viewerCount: 0,
          logId,
          peakViewers: 0,
          totalViewers: 0,
          connectCount: 0,
        };

        liveBroadcasters.set(userId, entry);
        socket.join('spotlight:live');

        socket.to('spotlight:live').emit('spotlight:new-broadcaster', {
          userId,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl,
          bio: entry.bio,
          note: entry.note,
          isVerified: entry.isVerified,
          location: entry.location,
          viewerCount: 0,
          startedAt: entry.startedAt.toISOString(),
        });

        socket.emit('spotlight:go-live-ok', { logId });
        logger.info({ userId, logId }, 'Broadcaster went live on Spotlight');
      } finally {
        pendingGoLive.delete(userId);
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error going live on Spotlight');
      socket.emit('spotlight:error', { message: 'Failed to go live' });
    }
  });

  // ── spotlight:end ──
  socket.on('spotlight:end', async () => {
    await endBroadcast(io, userId, 'self');
  });

  // ── spotlight:viewer-count ──
  // Broadcaster's Flutter app sends the current LiveKit participant count.
  // We store it and broadcast updated count to all viewers in the room.
  socket.on('spotlight:viewer-count', (data: { count: number }) => {
    const entry = liveBroadcasters.get(userId);
    if (!entry || typeof data?.count !== 'number') return;

    const count = Math.max(0, Math.floor(data.count));
    entry.viewerCount = count;
    entry.peakViewers = Math.max(entry.peakViewers, count);

    // Notify viewers watching this broadcaster of the updated count
    socket.to('spotlight:live').emit('spotlight:viewer-count-update', {
      broadcasterId: userId,
      viewerCount: count,
    });
  });

  // ── spotlight:list ──
  socket.on('spotlight:list', async (_, callback) => {
    try {
      const blockedIds = await getBlockedUserIds(userId);
      const list = await buildBroadcasterList(liveBroadcasters, userId, blockedIds);
      if (typeof callback === 'function') callback({ broadcasters: list });
      else socket.emit('spotlight:list', { broadcasters: list });
    } catch (error) {
      logger.error({ error, userId }, 'Error listing spotlight broadcasters');
      const empty = { broadcasters: [] };
      if (typeof callback === 'function') callback(empty);
      else socket.emit('spotlight:list', empty);
    }
  });

  // ── spotlight:connect ──
  socket.on('spotlight:connect', async (data: { broadcasterId: string }) => {
    try {
      if (!data?.broadcasterId || typeof data.broadcasterId !== 'string') return;
      const { broadcasterId } = data;
      const entry = liveBroadcasters.get(broadcasterId);
      if (!entry) {
        socket.emit('spotlight:error', { message: 'Broadcaster not found' });
        return;
      }

      // Claim this broadcaster atomically (sync) before any async work.
      // If another viewer already claimed them, bail out.
      if (pendingConnect.has(broadcasterId)) {
        socket.emit('spotlight:error', { message: 'Broadcaster is connecting with someone else' });
        return;
      }
      pendingConnect.add(broadcasterId);

      try {
        const blocked = await areUsersBlocked(userId, broadcasterId);
        if (blocked) {
          socket.emit('spotlight:error', { message: 'Cannot connect with this user' });
          return;
        }

        if (isUserInCall(userId) || isUserInCall(broadcasterId)) {
          socket.emit('spotlight:error', { message: 'User is already in a call' });
          return;
        }

        // Double-check broadcaster is still live (may have ended during async gap)
        if (!liveBroadcasters.has(broadcasterId)) {
          socket.emit('spotlight:error', { message: 'Broadcaster went offline' });
          return;
        }

        const conversationId = await findOrCreateConversation(userId, broadcasterId);
        entry.connectCount += 1;

        const callId = createDirectCall({
          conversationId,
          initiatorId: userId,
          participantIds: [userId, broadcasterId],
          callType: 'VIDEO',
        });

        const viewerSockets = await io.in(`user:${userId}`).fetchSockets();
        for (const s of viewerSockets) s.join(`call:${callId}`);
        const broadcasterSockets = await io.in(`user:${broadcasterId}`).fetchSockets();
        for (const s of broadcasterSockets) s.join(`call:${callId}`);

        try {
          await prisma.callLog.create({
            data: {
              callId,
              conversationId,
              initiatorId: userId,
              callType: 'VIDEO',
              status: 'COMPLETED',
            },
          });
        } catch (dbErr) {
          logger.error({ dbErr, callId }, 'Failed to create CallLog for spotlight connect');
        }

        const viewer = await prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true },
        });

        const payload = {
          conversationId,
          viewerId: userId,
          broadcasterId,
          callId,
          viewerName: viewer?.displayName ?? 'Unknown',
          broadcasterName: entry.displayName,
        };
        io.to(`user:${userId}`).emit('spotlight:connect-accepted', payload);
        io.to(`user:${broadcasterId}`).emit('spotlight:connect-accepted', payload);

        await endBroadcast(io, broadcasterId, 'connect');
        logger.info({ viewerId: userId, broadcasterId, conversationId }, 'Spotlight connect initiated');
      } finally {
        pendingConnect.delete(broadcasterId);
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error processing spotlight connect');
      socket.emit('spotlight:error', { message: 'Failed to connect' });
    }
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    if (liveBroadcasters.has(userId)) {
      logger.info({ userId, graceSec: DISCONNECT_GRACE_MS / 1000 }, 'Broadcaster disconnected — starting grace period');
      const timeout = setTimeout(() => {
        disconnectGrace.delete(userId);
        endBroadcast(io, userId, 'disconnect');
      }, DISCONNECT_GRACE_MS);
      disconnectGrace.set(userId, timeout);
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────

async function endBroadcast(io: Server, broadcasterId: string, reason: string): Promise<void> {
  const entry = liveBroadcasters.get(broadcasterId);
  if (!entry) return;

  io.to('spotlight:live').emit('spotlight:broadcaster-left', { broadcasterId });

  await endSpotlightLog(entry.logId, {
    peakViewers: entry.peakViewers,
    totalViewers: entry.totalViewers,
    connectCount: entry.connectCount,
  });

  liveBroadcasters.delete(broadcasterId);
  logger.info({ broadcasterId, reason }, 'Broadcaster ended spotlight');
}
