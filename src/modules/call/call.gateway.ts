import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';

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

      if (userCallMap.has(userId)) {
        socket.emit('call:error', { message: 'You are already in a call' });
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

      logger.info({ userId, callId, targetUserIds, callType: resolvedCallType }, 'Call initiated');
    } catch (error) {
      logger.error({ error, userId }, 'Error initiating call');
      socket.emit('call:error', { message: 'Failed to initiate call' });
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

      cleanupCall(callId);
    }

    logger.info({ userId, callId }, 'User disconnected during call');
  });
}

function cleanupCall(callId: string): void {
  const call = activeCalls.get(callId);
  if (!call) return;

  for (const participantId of call.participantIds) {
    userCallMap.delete(participantId);
  }
  activeCalls.delete(callId);
}
