import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { appendFileSync } from 'fs';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';

function debugLog(msg: string, data?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ''}\n`;
  try { appendFileSync('/tmp/yomeet-call-debug.log', line); } catch {}
}

interface ActiveCall {
  callId: string;
  conversationId: string;
  initiatorId: string;
  participantIds: Set<string>;
  isGroup: boolean;
  callType: 'AUDIO' | 'VIDEO';
  answeredAt?: Date;
}

/** In-memory store of active calls. */
const activeCalls = new Map<string, ActiveCall>();

/** Reverse index: userId -> callId for quick lookup. */
const userCallMap = new Map<string, string>();

/** Timeout handles for unanswered calls (server-side cleanup). */
const callTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** Maximum time (ms) to wait for an answer before cleaning up server-side. */
const CALL_TIMEOUT_MS = 60_000;

export function registerCallHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  /**
   * call:initiate — Start a new call. Notifies each target user
   * with caller info so the frontend can show an incoming call overlay.
   */
  socket.on('call:initiate', async (data: {
    conversationId: string;
    targetUserIds: string[];
    isGroup?: boolean;
    callType?: 'AUDIO' | 'VIDEO';
  }) => {
    try {
      const { conversationId, targetUserIds, isGroup, callType } = data;
      const resolvedCallType = callType ?? 'AUDIO';

      debugLog('call:initiate received', { userId, conversationId, targetUserIds, callType: resolvedCallType });
      logger.info({ userId, conversationId, targetUserIds, callType: resolvedCallType }, 'call:initiate received');

      // Clean up any stale call entry from a previous session
      const staleCallId = userCallMap.get(userId);
      if (staleCallId) {
        const staleCall = activeCalls.get(staleCallId);
        if (staleCall) {
          if (!staleCall.answeredAt) {
            debugLog('Cleaning up stale unanswered call', { userId, staleCallId });
            cleanupCall(staleCallId);
            clearCallTimeout(staleCallId);
          } else {
            debugLog('Blocking: user already in active call', { userId, staleCallId });
            socket.emit('call:error', { message: 'You are already in a call' });
            return;
          }
        } else {
          debugLog('Cleaning stale userCallMap entry (no call found)', { userId, staleCallId });
          userCallMap.delete(userId);
        }
      }

      const caller = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, avatarUrl: true },
      });

      const callId = randomUUID();
      const participantIds = new Set<string>([userId, ...targetUserIds]);

      activeCalls.set(callId, {
        callId,
        conversationId,
        initiatorId: userId,
        participantIds,
        isGroup: isGroup ?? false,
        callType: resolvedCallType,
      });

      userCallMap.set(userId, callId);

      // Create CallLog with initial MISSED status
      try {
        await prisma.callLog.create({
          data: {
            callId,
            conversationId,
            initiatorId: userId,
            callType: resolvedCallType,
            status: 'MISSED',
          },
        });
      } catch (dbErr) {
        logger.error({ dbErr, callId }, 'Failed to create CallLog');
      }

      socket.join(`call:${callId}`);

      // Notify each target user
      for (const targetId of targetUserIds) {
        // Debug: check if target has active sockets in their room
        const targetSockets = await io.in(`user:${targetId}`).fetchSockets();
        debugLog('Emitting call:incoming', { targetId, socketCount: targetSockets.length, callId });
        logger.info(
          { targetId, socketCount: targetSockets.length, callId },
          'Emitting call:incoming to target user room'
        );

        io.to(`user:${targetId}`).emit('call:incoming', {
          callId,
          conversationId,
          isGroup: isGroup ?? false,
          callType: resolvedCallType,
          callerName: caller?.displayName ?? 'Unknown',
          callerAvatar: caller?.avatarUrl ?? null,
          participants: Array.from(participantIds)
            .filter((id) => id !== targetId)
            .map((id) => ({ userId: id })),
        });
      }

      // Confirm to the initiator
      socket.emit('call:initiated', { callId, callType: resolvedCallType });

      // Server-side timeout: clean up if nobody answers
      const timeout = setTimeout(async () => {
        const call = activeCalls.get(callId);
        if (call && !call.answeredAt) {
          io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: 'timeout' });
          // Make all sockets leave the call room
          const sockets = await io.in(`call:${callId}`).fetchSockets();
          for (const s of sockets) s.leave(`call:${callId}`);

          // Bump conversation.updatedAt so it sorts to the top of the list
          try {
            await prisma.conversation.update({
              where: { id: conversationId },
              data: { updatedAt: new Date() },
            });
          } catch (dbErr) {
            logger.error({ dbErr, callId, conversationId }, 'Failed to bump conversation updatedAt on missed call');
          }

          cleanupCall(callId);
          logger.info({ callId }, 'Call timed out server-side (no answer)');
        }
        callTimeouts.delete(callId);
      }, CALL_TIMEOUT_MS);
      callTimeouts.set(callId, timeout);

      logger.info({ userId, callId, targetUserIds, callType: resolvedCallType }, 'Call initiated');
    } catch (error) {
      debugLog('ERROR in call:initiate', { userId, error: String(error) });
      logger.error({ error, userId }, 'Error initiating call');
      socket.emit('call:error', { message: 'Failed to initiate call' });
    }
  });

  /**
   * call:ringing — The target's phone is ringing. Relay to the caller.
   */
  socket.on('call:ringing', (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = activeCalls.get(callId);
      if (!call || !call.participantIds.has(userId)) return;

      io.to(`user:${call.initiatorId}`).emit('call:ringing', { callId });
    } catch (error) {
      logger.error({ error, userId }, 'Error relaying ringing');
    }
  });

  /**
   * call:answer — Accept an incoming call. Notifies the caller
   * so both sides can begin the WebRTC handshake.
   */
  socket.on('call:answer', async (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = activeCalls.get(callId);

      if (!call || !call.participantIds.has(userId)) {
        socket.emit('call:error', { message: 'Call not found' });
        return;
      }

      userCallMap.set(userId, callId);
      socket.join(`call:${callId}`);
      call.answeredAt = new Date();
      clearCallTimeout(callId);

      // Update CallLog to COMPLETED
      try {
        await prisma.callLog.update({
          where: { callId },
          data: { status: 'COMPLETED' },
        });
      } catch (dbErr) {
        logger.error({ dbErr, callId }, 'Failed to update CallLog on answer');
      }

      // Notify the initiator that the call was answered
      io.to(`user:${call.initiatorId}`).emit('call:answered', {
        callId,
        userId,
      });

      logger.info({ userId, callId }, 'Call answered');
    } catch (error) {
      logger.error({ error, userId }, 'Error answering call');
      socket.emit('call:error', { message: 'Failed to answer call' });
    }
  });

  /**
   * call:reject — Decline an incoming call. Notifies the caller.
   */
  socket.on('call:reject', async (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = activeCalls.get(callId);

      if (!call || !call.participantIds.has(userId)) return;

      io.to(`user:${call.initiatorId}`).emit('call:rejected', {
        callId,
        userId,
      });

      // Update CallLog to REJECTED
      try {
        await prisma.callLog.update({
          where: { callId },
          data: { status: 'REJECTED', endedAt: new Date() },
        });
      } catch (dbErr) {
        logger.error({ dbErr, callId }, 'Failed to update CallLog on reject');
      }

      // For 1-on-1 calls, clean up immediately
      if (!call.isGroup) {
        // Make all sockets leave the call room
        const rejectSockets = await io.in(`call:${callId}`).fetchSockets();
        for (const s of rejectSockets) s.leave(`call:${callId}`);
        cleanupCall(callId);
      } else {
        call.participantIds.delete(userId);
        userCallMap.delete(userId);
      }

      logger.info({ userId, callId }, 'Call rejected');
    } catch (error) {
      logger.error({ error, userId }, 'Error rejecting call');
    }
  });

  /**
   * call:signal — Relay WebRTC signaling data (offer/answer/ICE)
   * from one peer to another.
   */
  socket.on('call:signal', (data: {
    callId: string;
    to: string;
    type: string;
    sdp?: string;
    candidate?: Record<string, unknown>;
  }) => {
    try {
      const { callId, to, type, sdp, candidate } = data;
      const call = activeCalls.get(callId);

      if (!call || !call.participantIds.has(userId)) return;

      io.to(`user:${to}`).emit('call:signal', {
        callId,
        from: userId,
        type,
        sdp,
        candidate,
      });
    } catch (error) {
      logger.error({ error, userId }, 'Error relaying signal');
    }
  });

  /**
   * call:end — End the call. Notifies all participants.
   */
  socket.on('call:end', async (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = activeCalls.get(callId);

      if (!call) return;

      // Update CallLog with endedAt and durationSecs
      try {
        const now = new Date();
        const durationSecs = call.answeredAt
          ? Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)
          : undefined;
        await prisma.callLog.update({
          where: { callId },
          data: {
            endedAt: now,
            ...(durationSecs !== undefined ? { durationSecs } : {}),
          },
        });
      } catch (dbErr) {
        logger.error({ dbErr, callId }, 'Failed to update CallLog on end');
      }

      // Notify all other participants
      socket.to(`call:${callId}`).emit('call:ended', {
        callId,
        endedBy: userId,
      });

      // Make all sockets leave the call room
      const endSockets = await io.in(`call:${callId}`).fetchSockets();
      for (const s of endSockets) s.leave(`call:${callId}`);

      cleanupCall(callId);
      logger.info({ userId, callId }, 'Call ended');
    } catch (error) {
      logger.error({ error, userId }, 'Error ending call');
    }
  });

  /**
   * On disconnect, end any active call the user is in.
   */
  socket.on('disconnect', () => {
    const callId = userCallMap.get(userId);
    if (!callId) return;

    const call = activeCalls.get(callId);
    if (!call) return;

    if (call.isGroup && call.participantIds.size > 2) {
      // Group call: notify others this participant left
      call.participantIds.delete(userId);
      userCallMap.delete(userId);
      socket.to(`call:${callId}`).emit('call:participant-left', {
        callId,
        userId,
      });
    } else {
      // 1-on-1 or last participant: end the call
      socket.to(`call:${callId}`).emit('call:ended', {
        callId,
        endedBy: userId,
      });

      // Update CallLog
      const now = new Date();
      const durationSecs = call.answeredAt
        ? Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)
        : undefined;
      prisma.callLog.update({
        where: { callId },
        data: {
          endedAt: now,
          ...(durationSecs !== undefined ? { durationSecs } : {}),
        },
      }).catch((dbErr) => {
        logger.error({ dbErr, callId }, 'Failed to update CallLog on disconnect');
      });

      // Make remaining sockets leave the call room
      io.in(`call:${callId}`).fetchSockets().then((sockets) => {
        for (const s of sockets) s.leave(`call:${callId}`);
      }).catch(() => {});

      cleanupCall(callId);
    }

    logger.info({ userId, callId }, 'User disconnected during call');
  });
}

function clearCallTimeout(callId: string): void {
  const timeout = callTimeouts.get(callId);
  if (timeout) {
    clearTimeout(timeout);
    callTimeouts.delete(callId);
  }
}

function cleanupCall(callId: string): void {
  const call = activeCalls.get(callId);
  if (!call) return;

  clearCallTimeout(callId);
  for (const participantId of call.participantIds) {
    userCallMap.delete(participantId);
  }
  activeCalls.delete(callId);
}
