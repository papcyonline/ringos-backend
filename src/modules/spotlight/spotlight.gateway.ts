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
  viewerIds: Set<string>;
  logId: string;
  peakViewers: number;
  totalViewers: number;
  connectCount: number;
}

// ─── In-memory state (exported read-only for REST endpoint) ──

/** userId -> BroadcasterEntry */
export const liveBroadcasters = new Map<string, BroadcasterEntry>();

/** viewerUserId -> broadcasterUserId */
const viewerToBroadcaster = new Map<string, string>();

/** Grace period timers for disconnected users */
const disconnectGrace = new Map<string, { timeout: ReturnType<typeof setTimeout>; role: 'broadcaster' | 'viewer' }>();

/** Async guard: prevents double go-live while DB write is in-flight */
const pendingGoLive = new Set<string>();

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

  // ── spotlight:join-room — let any user join the broadcast room to receive updates ──
  socket.on('spotlight:join-room', () => {
    socket.join('spotlight:live');
  });

  // ── spotlight:leave-room — stop receiving broadcast updates ──
  socket.on('spotlight:leave-room', () => {
    socket.leave('spotlight:live');
  });

  // ── spotlight:go-live ──
  socket.on('spotlight:go-live', async (data: { note?: string }) => {
    try {
      if (data?.note != null && typeof data.note !== 'string') return;

      // Async race guard
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
          viewerIds: new Set(),
          logId,
          peakViewers: 0,
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

  // ── spotlight:list — uses DRY helpers from service ──
  socket.on('spotlight:list', async (_, callback) => {
    try {
      const blockedIds = await getBlockedUserIds(userId);
      const list = buildBroadcasterList(liveBroadcasters, userId, blockedIds);

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
  socket.on('spotlight:viewer-join', async (data: { broadcasterId: string }) => {
    try {
      if (!data?.broadcasterId || typeof data.broadcasterId !== 'string') return;
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

      // Block check: prevent blocked users from viewing each other
      const blocked = await areUsersBlocked(userId, broadcasterId);
      if (blocked) {
        socket.emit('spotlight:error', { message: 'Cannot view this broadcaster' });
        return;
      }

      // Clean up previous viewer connection if any
      const prevBroadcaster = viewerToBroadcaster.get(userId);
      if (prevBroadcaster && prevBroadcaster !== broadcasterId) {
        removeViewer(io, userId, prevBroadcaster);
      }

      entry.viewerIds.add(userId);
      entry.totalViewers += 1;
      entry.peakViewers = Math.max(entry.peakViewers, entry.viewerIds.size);
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
      if (!data?.to || typeof data.to !== 'string' || !data?.type || typeof data.type !== 'string') return;
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
      if (!data?.broadcasterId || typeof data.broadcasterId !== 'string') return;
      const { broadcasterId } = data;
      const entry = liveBroadcasters.get(broadcasterId);
      if (!entry) {
        socket.emit('spotlight:error', { message: 'Broadcaster not found' });
        return;
      }

      // Block check before creating conversation
      const blocked = await areUsersBlocked(userId, broadcasterId);
      if (blocked) {
        socket.emit('spotlight:error', { message: 'Cannot connect with this user' });
        return;
      }

      // Prevent connecting if either user is already in a call
      if (isUserInCall(userId) || isUserInCall(broadcasterId)) {
        socket.emit('spotlight:error', { message: 'User is already in a call' });
        return;
      }

      // ACID-safe find-or-create conversation
      const conversationId = await findOrCreateConversation(userId, broadcasterId);

      entry.connectCount += 1;

      // Create call directly — no ringing, instant connect
      const callId = createDirectCall({
        conversationId,
        initiatorId: userId,
        participantIds: [userId, broadcasterId],
        callType: 'VIDEO',
      });

      // Join both users' sockets to the call room for signal relay
      const viewerSockets = await io.in(`user:${userId}`).fetchSockets();
      for (const s of viewerSockets) s.join(`call:${callId}`);
      const broadcasterSockets = await io.in(`user:${broadcasterId}`).fetchSockets();
      for (const s of broadcasterSockets) s.join(`call:${callId}`);

      // Create CallLog as COMPLETED (no missed-call timeout needed)
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

      // Notify both sides with callId for direct connect
      const payload = { conversationId, viewerId: userId, broadcasterId, callId };
      io.to(`user:${userId}`).emit('spotlight:connect-accepted', payload);
      io.to(`user:${broadcasterId}`).emit('spotlight:connect-accepted', payload);

      // End the broadcast so other viewers don't see a stale feed
      await endBroadcast(io, broadcasterId, 'connect');

      logger.info({ viewerId: userId, broadcasterId, conversationId }, 'Spotlight connect initiated');
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
    peakViewers: entry.peakViewers,
    totalViewers: entry.totalViewers,
    connectCount: entry.connectCount,
  });

  liveBroadcasters.delete(broadcasterId);
  logger.info({ broadcasterId, reason }, 'Broadcaster ended spotlight');
}
