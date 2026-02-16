import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { sendCallPush } from '../notification/notification.service';
import { checkCallMinutes, addCallMinutes } from '../../shared/usage.service';

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

/** Grace period (ms) before ending a call on disconnect. Allows brief reconnections. */
const DISCONNECT_GRACE_MS = 10_000;

/** Pending disconnect timers: userId -> { timeout, callId } */
const disconnectGrace = new Map<string, { timeout: ReturnType<typeof setTimeout>; callId: string }>();

export function registerCallHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  // ── Reconnection: cancel pending disconnect grace if user reconnects ──
  const pending = disconnectGrace.get(userId);
  if (pending) {
    clearTimeout(pending.timeout);
    disconnectGrace.delete(userId);
    const call = activeCalls.get(pending.callId);
    if (call) {
      socket.join(`call:${pending.callId}`);
      logger.info({ userId, callId: pending.callId }, 'User reconnected during call — grace period cancelled');
    }
  }

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

      logger.info({ userId, conversationId, targetUserIds, callType: resolvedCallType }, 'call:initiate received');

      // Clean up any stale call entry from a previous session
      const staleCallId = userCallMap.get(userId);
      if (staleCallId) {
        const staleCall = activeCalls.get(staleCallId);
        if (staleCall) {
          if (!staleCall.answeredAt) {
            cleanupCall(staleCallId);
            clearCallTimeout(staleCallId);
          } else {
            socket.emit('call:error', { message: 'You are already in a call' });
            return;
          }
        } else {
          userCallMap.delete(userId);
        }
      }

      // Check daily call-minute limit for free users
      const usageCheck = await checkCallMinutes(userId);
      if (!usageCheck.allowed) {
        socket.emit('call:error', {
          message: 'Daily call limit reached',
          code: 'CALL_LIMIT',
          resetAt: usageCheck.resetAt,
        });
        return;
      }

      // Verify caller is a participant in the conversation
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!participant || participant.leftAt) {
        socket.emit('call:error', { message: 'You are not a participant in this conversation' });
        return;
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
        // Check if target has active sockets in their room
        const targetSockets = await io.in(`user:${targetId}`).fetchSockets();
        const isOnline = targetSockets.length > 0;

        logger.info(
          { targetId, socketCount: targetSockets.length, callId, isOnline },
          'Emitting call:incoming to target user room'
        );

        if (isOnline) {
          // User is online - send via socket
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
        } else {
          // User is offline - send push notification
          sendCallPush(targetId, {
            callId,
            conversationId,
            callType: resolvedCallType,
            callerId: userId,
            callerName: caller?.displayName ?? 'Unknown',
            callerAvatar: caller?.avatarUrl,
          }).catch((err) => {
            logger.error({ err, targetId, callId }, 'Failed to send call push notification');
          });
        }
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
  socket.on('call:signal', async (data: {
    callId: string;
    to: string;
    type: string;
    sdp?: string;
    candidate?: Record<string, unknown>;
  }) => {
    try {
      const { callId, to, type, sdp, candidate } = data;
      const call = activeCalls.get(callId);

      if (!call) {
        logger.warn({ callId, userId, type }, 'call:signal dropped — call not found in activeCalls');
        return;
      }
      if (!call.participantIds.has(userId)) {
        logger.warn({ callId, userId, type }, 'call:signal dropped — sender not in participantIds');
        return;
      }

      // Verify the target has active sockets
      const targetSockets = await io.in(`user:${to}`).fetchSockets();
      logger.info(
        { callId, from: userId, to, type, targetSocketCount: targetSockets.length },
        'Relaying call:signal',
      );

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

      // Calculate duration
      const now = new Date();
      const durationSecs = call.answeredAt
        ? Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)
        : undefined;

      // Update CallLog with endedAt and durationSecs
      try {
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

      // Track call minutes for all participants
      if (durationSecs !== undefined && durationSecs > 0) {
        for (const pid of call.participantIds) {
          addCallMinutes(pid, durationSecs).catch((err) => {
            logger.error({ err, userId: pid, callId }, 'Failed to track call minutes');
          });
        }
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
   * On disconnect, start a grace period before ending the call.
   * Mobile sockets frequently drop briefly (transport switch, background,
   * network change). If the user reconnects within DISCONNECT_GRACE_MS,
   * the call stays alive.
   */
  socket.on('disconnect', () => {
    const callId = userCallMap.get(userId);
    if (!callId) return;

    const call = activeCalls.get(callId);
    if (!call) return;

    logger.info({ userId, callId, graceSec: DISCONNECT_GRACE_MS / 1000 }, 'User disconnected during call — starting grace period');

    const timeout = setTimeout(async () => {
      disconnectGrace.delete(userId);

      // Re-check: the call might have ended normally during the grace period
      const currentCall = activeCalls.get(callId);
      if (!currentCall) return;

      if (currentCall.isGroup && currentCall.participantIds.size > 2) {
        currentCall.participantIds.delete(userId);
        userCallMap.delete(userId);
        io.to(`call:${callId}`).emit('call:participant-left', { callId, userId });
      } else {
        // Grace period expired — end the call
        io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: userId });

        const now = new Date();
        const durationSecs = currentCall.answeredAt
          ? Math.round((now.getTime() - currentCall.answeredAt.getTime()) / 1000)
          : undefined;

        prisma.callLog.update({
          where: { callId },
          data: { endedAt: now, ...(durationSecs !== undefined ? { durationSecs } : {}) },
        }).catch((dbErr) => {
          logger.error({ dbErr, callId }, 'Failed to update CallLog on disconnect grace expiry');
        });

        if (durationSecs !== undefined && durationSecs > 0) {
          for (const pid of currentCall.participantIds) {
            addCallMinutes(pid, durationSecs).catch((err) => {
              logger.error({ err, userId: pid, callId }, 'Failed to track call minutes');
            });
          }
        }

        io.in(`call:${callId}`).fetchSockets().then((sockets) => {
          for (const s of sockets) s.leave(`call:${callId}`);
        }).catch(() => {});

        cleanupCall(callId);
        logger.info({ userId, callId }, 'Call ended after disconnect grace period expired');
      }
    }, DISCONNECT_GRACE_MS);

    disconnectGrace.set(userId, { timeout, callId });
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
