import { Server, Socket } from 'socket.io';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { createSpotlightLog, endSpotlightLog } from './spotlight.service';
import { userCallMap } from '../call/call.gateway';

// ─── Types ──────────────────────────────────────────────────

interface BroadcasterEntry {
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  note: string | null;
  startedAt: Date;
  viewerIds: Set<string>;
  logId: string;
  totalViewers: number;
  connectCount: number;
}

// ─── In-memory state (exported for REST endpoint) ──────────

/** userId -> BroadcasterEntry */
export const liveBroadcasters = new Map<string, BroadcasterEntry>();

/** viewerUserId -> broadcasterUserId */
const viewerToBroadcaster = new Map<string, string>();

/** Grace period timers for disconnected users */
const disconnectGrace = new Map<string, { timeout: ReturnType<typeof setTimeout>; role: 'broadcaster' | 'viewer' }>();

const MAX_VIEWERS_PER_BROADCASTER = 8;
const DISCONNECT_GRACE_MS = 10_000;

// ─── Handler registration ───────────────────────────────────

export function registerSpotlightHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  // ── Reconnection: cancel pending disconnect grace ──
  const pending = disconnectGrace.get(userId);
  if (pending) {
    clearTimeout(pending.timeout);
    disconnectGrace.delete(userId);

    if (pending.role === 'broadcaster' && liveBroadcasters.has(userId)) {
      socket.join('spotlight:live');
      logger.info({ userId }, 'Broadcaster reconnected during spotlight grace period');
    } else if (pending.role === 'viewer') {
      const broadcasterId = viewerToBroadcaster.get(userId);
      if (broadcasterId) {
        logger.info({ userId, broadcasterId }, 'Viewer reconnected during spotlight grace period');
      }
    }
  }

  // ── spotlight:go-live ──
  socket.on('spotlight:go-live', async (data: { note?: string }) => {
    try {
      if (liveBroadcasters.has(userId)) {
        socket.emit('spotlight:error', { message: 'Already broadcasting' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, avatarUrl: true, bio: true },
      });
      if (!user) return;

      const logId = await createSpotlightLog(userId, data.note);

      const entry: BroadcasterEntry = {
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        note: data.note ?? null,
        startedAt: new Date(),
        viewerIds: new Set(),
        logId,
        totalViewers: 0,
        connectCount: 0,
      };

      liveBroadcasters.set(userId, entry);
      socket.join('spotlight:live');

      // Notify all viewers in the spotlight room about the new broadcaster
      socket.to('spotlight:live').emit('spotlight:new-broadcaster', {
        userId,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl,
        bio: entry.bio,
        note: entry.note,
        viewerCount: 0,
        startedAt: entry.startedAt.toISOString(),
      });

      socket.emit('spotlight:go-live-ok', { logId });
      logger.info({ userId, logId }, 'Broadcaster went live on Spotlight');
    } catch (error) {
      logger.error({ error, userId }, 'Error going live on Spotlight');
      socket.emit('spotlight:error', { message: 'Failed to go live' });
    }
  });

  // ── spotlight:end ──
  socket.on('spotlight:end', async () => {
    await endBroadcast(io, userId, 'self');
  });

  // ── spotlight:list ──
  socket.on('spotlight:list', async (_, callback) => {
    try {
      // Fetch blocks for the requesting user
      const blocks = await prisma.block.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      });
      const blockedIds = new Set<string>();
      for (const b of blocks) {
        blockedIds.add(b.blockerId === userId ? b.blockedId : b.blockerId);
      }

      const list = Array.from(liveBroadcasters.entries())
        .filter(([id]) => id !== userId && !blockedIds.has(id) && !userCallMap.has(id))
        .map(([id, entry]) => ({
          userId: id,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl,
          bio: entry.bio,
          note: entry.note,
          viewerCount: entry.viewerIds.size,
          startedAt: entry.startedAt.toISOString(),
        }));

      if (typeof callback === 'function') {
        callback({ broadcasters: list });
      } else {
        socket.emit('spotlight:list', { broadcasters: list });
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error listing spotlight broadcasters');
      const empty = { broadcasters: [] };
      if (typeof callback === 'function') callback(empty);
      else socket.emit('spotlight:list', empty);
    }
  });

  // ── spotlight:viewer-join ──
  socket.on('spotlight:viewer-join', (data: { broadcasterId: string }) => {
    try {
      const { broadcasterId } = data;
      const entry = liveBroadcasters.get(broadcasterId);
      if (!entry) {
        socket.emit('spotlight:error', { message: 'Broadcaster not found' });
        return;
      }

      if (entry.viewerIds.size >= MAX_VIEWERS_PER_BROADCASTER) {
        socket.emit('spotlight:error', { message: 'Broadcaster is full', code: 'FULL' });
        return;
      }

      // Clean up previous viewer connection if any
      const prevBroadcaster = viewerToBroadcaster.get(userId);
      if (prevBroadcaster && prevBroadcaster !== broadcasterId) {
        removeViewer(io, userId, prevBroadcaster);
      }

      entry.viewerIds.add(userId);
      entry.totalViewers += 1;
      viewerToBroadcaster.set(userId, broadcasterId);
      socket.join('spotlight:live');

      // Tell the broadcaster to create a WebRTC offer for this viewer
      io.to(`user:${broadcasterId}`).emit('spotlight:viewer-joined', {
        viewerId: userId,
        viewerCount: entry.viewerIds.size,
      });

      // Also tell the viewer it's joined successfully
      socket.emit('spotlight:viewer-join-ok', {
        broadcasterId,
        viewerCount: entry.viewerIds.size,
      });

      logger.info({ viewerId: userId, broadcasterId, viewerCount: entry.viewerIds.size }, 'Viewer joined spotlight');
    } catch (error) {
      logger.error({ error, userId }, 'Error joining spotlight as viewer');
    }
  });

  // ── spotlight:viewer-leave ──
  socket.on('spotlight:viewer-leave', () => {
    const broadcasterId = viewerToBroadcaster.get(userId);
    if (broadcasterId) {
      removeViewer(io, userId, broadcasterId);
    }
  });

  // ── spotlight:signal — relay WebRTC signaling ──
  socket.on('spotlight:signal', (data: {
    to: string;
    type: string;
    sdp?: string;
    candidate?: Record<string, unknown>;
  }) => {
    try {
      const { to, type, sdp, candidate } = data;

      io.to(`user:${to}`).emit('spotlight:signal', {
        from: userId,
        type,
        sdp,
        candidate,
      });
    } catch (error) {
      logger.error({ error, userId }, 'Error relaying spotlight signal');
    }
  });

  // ── spotlight:connect — viewer wants to video-call the broadcaster ──
  socket.on('spotlight:connect', async (data: { broadcasterId: string }) => {
    try {
      const { broadcasterId } = data;
      const entry = liveBroadcasters.get(broadcasterId);
      if (!entry) {
        socket.emit('spotlight:error', { message: 'Broadcaster not found' });
        return;
      }

      // Get or create 1-on-1 conversation between viewer and broadcaster
      let conversation = await prisma.conversation.findFirst({
        where: {
          type: 'HUMAN_MATCHED',
          participants: {
            every: { userId: { in: [userId, broadcasterId] } },
          },
        },
        include: { participants: true },
      });

      if (!conversation || conversation.participants.length !== 2) {
        conversation = await prisma.conversation.create({
          data: {
            type: 'HUMAN_MATCHED',
            participants: {
              create: [
                { userId, role: 'MEMBER' },
                { userId: broadcasterId, role: 'MEMBER' },
              ],
            },
          },
          include: { participants: true },
        });
      }

      entry.connectCount += 1;

      // Notify both sides
      const payload = { conversationId: conversation.id, viewerId: userId, broadcasterId };
      io.to(`user:${userId}`).emit('spotlight:connect-accepted', payload);
      io.to(`user:${broadcasterId}`).emit('spotlight:connect-accepted', payload);

      logger.info({ viewerId: userId, broadcasterId, conversationId: conversation.id }, 'Spotlight connect initiated');
    } catch (error) {
      logger.error({ error, userId }, 'Error processing spotlight connect');
      socket.emit('spotlight:error', { message: 'Failed to connect' });
    }
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    // Broadcaster disconnect — grace period
    if (liveBroadcasters.has(userId)) {
      logger.info({ userId, graceSec: DISCONNECT_GRACE_MS / 1000 }, 'Broadcaster disconnected — starting grace period');

      const timeout = setTimeout(() => {
        disconnectGrace.delete(userId);
        endBroadcast(io, userId, 'disconnect');
      }, DISCONNECT_GRACE_MS);

      disconnectGrace.set(userId, { timeout, role: 'broadcaster' });
      return;
    }

    // Viewer disconnect — immediate cleanup
    const broadcasterId = viewerToBroadcaster.get(userId);
    if (broadcasterId) {
      removeViewer(io, userId, broadcasterId);
    }
  });
}

// ─── Helpers ────────────────────────────────────────────────

function removeViewer(io: Server, viewerId: string, broadcasterId: string): void {
  const entry = liveBroadcasters.get(broadcasterId);
  if (entry) {
    entry.viewerIds.delete(viewerId);
    io.to(`user:${broadcasterId}`).emit('spotlight:viewer-left', {
      viewerId,
      viewerCount: entry.viewerIds.size,
    });
  }
  viewerToBroadcaster.delete(viewerId);
}

async function endBroadcast(io: Server, broadcasterId: string, reason: string): Promise<void> {
  const entry = liveBroadcasters.get(broadcasterId);
  if (!entry) return;

  // Notify all viewers
  for (const viewerId of entry.viewerIds) {
    io.to(`user:${viewerId}`).emit('spotlight:broadcaster-left', { broadcasterId });
    viewerToBroadcaster.delete(viewerId);
  }

  // End the SpotlightLog
  await endSpotlightLog(entry.logId, {
    peakViewers: entry.totalViewers,
    totalViewers: entry.totalViewers,
    connectCount: entry.connectCount,
  });

  liveBroadcasters.delete(broadcasterId);
  logger.info({ broadcasterId, reason }, 'Broadcaster ended spotlight');
}
