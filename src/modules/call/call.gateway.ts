import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { sendCallPush, sendMissedCallNotification } from '../notification/notification.service';
import { checkCallMinutes, addCallMinutes } from '../../shared/usage.service';
import { generateCallToken, LIVEKIT_URL } from './call.livekit';
import { isBlocked } from '../safety/safety.service';

interface ActiveCall {
  callId: string;
  conversationId: string;
  initiatorId: string;
  participantIds: Set<string>;
  isGroup: boolean;
  callType: 'AUDIO' | 'VIDEO';
  answeredAt?: Date;
}

/**
 * Maximum time (ms) to wait for an answer before cleaning up server-side.
 * Kept marginally higher than the client outgoing timeout so the client
 * (which knows to give up first) drives the "no answer" UX.
 */
const CALL_TIMEOUT_MS = 45_000;

/** Grace period (ms) before ending a call on disconnect. Allows brief reconnections. */
const DISCONNECT_GRACE_MS = 10_000;

/** Encapsulates all in-memory call state: active calls, user→call mapping, timeouts, and disconnect grace periods. */
class CallStateManager {
  /** Active calls keyed by callId. */
  readonly calls = new Map<string, ActiveCall>();

  /** Reverse index: userId → callId for quick lookup. */
  readonly userCall = new Map<string, string>();

  /** Timeout handles for unanswered calls (server-side cleanup). */
  readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /** Pending disconnect timers: userId → { timeout, callId }. */
  readonly disconnectGrace = new Map<string, { timeout: ReturnType<typeof setTimeout>; callId: string }>();

  isUserInCall(userId: string): boolean {
    return this.userCall.has(userId);
  }

  getCall(callId: string): ActiveCall | undefined {
    return this.calls.get(callId);
  }

  getUserCallId(userId: string): string | undefined {
    return this.userCall.get(userId);
  }

  addCall(call: ActiveCall): void {
    this.calls.set(call.callId, call);
  }

  mapUserToCall(userId: string, callId: string): void {
    this.userCall.set(userId, callId);
  }

  unmapUser(userId: string): void {
    this.userCall.delete(userId);
  }

  setTimeout(callId: string, timeout: ReturnType<typeof globalThis.setTimeout>): void {
    this.timeouts.set(callId, timeout);
  }

  clearTimeout(callId: string): void {
    const timeout = this.timeouts.get(callId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(callId);
    }
  }

  cleanup(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    this.clearTimeout(callId);
    for (const participantId of call.participantIds) {
      this.userCall.delete(participantId);
    }
    this.calls.delete(callId);
  }
}

const callState = new CallStateManager();

/**
 * Shared call-end logic: calculate duration, update DB, track minutes, remove sockets, cleanup state.
 * Used by both the explicit call:end handler and the disconnect grace expiry.
 */
async function finalizeCallEnd(io: Server, callId: string, call: ActiveCall): Promise<void> {
  const now = new Date();
  const durationSecs = call.answeredAt
    ? Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)
    : undefined;

  try {
    await prisma.callLog.update({
      where: { callId },
      data: { endedAt: now, ...(durationSecs !== undefined ? { durationSecs } : {}) },
    });
  } catch (dbErr) {
    logger.error({ dbErr, callId }, 'Failed to update CallLog on end');
  }

  if (durationSecs !== undefined && durationSecs > 0) {
    for (const pid of call.participantIds) {
      addCallMinutes(pid, durationSecs).catch((err) => {
        logger.error({ err, userId: pid, callId }, 'Failed to track call minutes');
      });
    }
  }

  const sockets = await io.in(`call:${callId}`).fetchSockets();
  for (const s of sockets) s.leave(`call:${callId}`);

  callState.cleanup(callId);
}

/** Check whether a user is currently in an active call. */
export function isUserInCall(userId: string): boolean {
  return callState.isUserInCall(userId);
}

/**
 * Create a call entry that is already "answered" — no ringing phase.
 * Used by Spotlight direct-connect to skip the incoming-call flow.
 * Returns the generated callId.
 */
export function createDirectCall(params: {
  conversationId: string;
  initiatorId: string;
  participantIds: string[];
  callType: 'AUDIO' | 'VIDEO';
}): string {
  const callId = randomUUID();
  const call: ActiveCall = {
    callId,
    conversationId: params.conversationId,
    initiatorId: params.initiatorId,
    participantIds: new Set(params.participantIds),
    isGroup: false,
    callType: params.callType,
    answeredAt: new Date(), // Already answered — skip ringing
  };
  callState.addCall(call);
  for (const pid of params.participantIds) {
    callState.mapUserToCall(pid, callId);
  }
  return callId;
}

export function registerCallHandlers(io: Server, socket: Socket): void {
  const userId: string = (socket as any).userId;

  // ── Reconnection: cancel pending disconnect grace if user reconnects ──
  const pending = callState.disconnectGrace.get(userId);
  if (pending) {
    clearTimeout(pending.timeout);
    callState.disconnectGrace.delete(userId);
    const call = callState.getCall(pending.callId);
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

      // Validate targetUserIds bounds
      if (!Array.isArray(targetUserIds) || targetUserIds.length === 0 || targetUserIds.length > 20) {
        socket.emit('call:error', { message: 'Invalid number of participants (1-20)' });
        return;
      }

      logger.info({ userId, conversationId, targetUserIds, callType: resolvedCallType }, 'call:initiate received');

      // Clean up any stale call entry from a previous session
      const staleCallId = callState.getUserCallId(userId);
      if (staleCallId) {
        const staleCall = callState.getCall(staleCallId);
        if (staleCall) {
          if (!staleCall.answeredAt) {
            callState.cleanup(staleCallId);
          } else {
            socket.emit('call:error', { message: 'You are already in a call' });
            return;
          }
        } else {
          callState.unmapUser(userId);
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

      // Verify each target is also an active participant. A user removed from
      // the conversation shouldn't be callable even if the caller still has
      // their id from a cached participant list.
      const targetParticipations = await prisma.conversationParticipant.findMany({
        where: { conversationId, userId: { in: targetUserIds } },
        select: { userId: true, leftAt: true },
      });
      const activeTargets = new Set(
        targetParticipations.filter((p) => p.leftAt == null).map((p) => p.userId),
      );
      const droppedTargets = targetUserIds.filter((id) => !activeTargets.has(id));
      if (droppedTargets.length > 0) {
        socket.emit('call:error', {
          message: 'One or more recipients are no longer in this conversation',
          code: 'TARGET_NOT_PARTICIPANT',
          droppedTargets,
        });
        return;
      }

      // Block check — only applies to 1-on-1 calls. Group/channel calls are
      // gated by group membership (removing a blocked user from a group is
      // handled elsewhere).
      if (!(isGroup ?? false) && targetUserIds.length === 1) {
        const [targetId] = targetUserIds;
        const blocked = await isBlocked(userId, targetId);
        if (blocked) {
          socket.emit('call:error', {
            message: 'Cannot call this user',
            code: 'BLOCKED',
          });
          return;
        }
      }

      // Busy check — if any target is already in another call, tell the
      // caller immediately rather than ringing for the full timeout window.
      const busyTargets = targetUserIds.filter((id) => callState.isUserInCall(id));
      if (busyTargets.length > 0 && targetUserIds.length === 1) {
        socket.emit('call:busy', {
          busyUserIds: busyTargets,
          code: 'BUSY',
        });
        return;
      }

      // Unavailable check — for 1-on-1, make sure the target has at least one
      // path to ring on (live socket, VoIP token, or FCM token). Otherwise
      // the call would ring for 45s and report "missed" to a phantom user.
      if (targetUserIds.length === 1) {
        const [targetId] = targetUserIds;
        const [targetSockets, voipCount, fcmCount] = await Promise.all([
          io.in(`user:${targetId}`).fetchSockets(),
          prisma.voipToken.count({ where: { userId: targetId } }),
          prisma.fcmToken.count({ where: { userId: targetId } }),
        ]);
        if (targetSockets.length === 0 && voipCount === 0 && fcmCount === 0) {
          socket.emit('call:unavailable', { targetUserId: targetId });
          return;
        }
      }

      const caller = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, avatarUrl: true },
      });

      const callId = randomUUID();
      const participantIds = new Set<string>([userId, ...targetUserIds]);

      callState.addCall({
        callId,
        conversationId,
        initiatorId: userId,
        participantIds,
        isGroup: isGroup ?? false,
        callType: resolvedCallType,
      });

      callState.mapUserToCall(userId, callId);

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

      // Fetch display names for all participants (for call UI)
      const participantUsers = await prisma.user.findMany({
        where: { id: { in: Array.from(participantIds) } },
        select: { id: true, displayName: true, avatarUrl: true },
      });
      const userMap = new Map(participantUsers.map((u) => [u.id, u]));

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
          // User is online — send via socket
          io.to(`user:${targetId}`).emit('call:incoming', {
            callId,
            conversationId,
            isGroup: isGroup ?? false,
            callType: resolvedCallType,
            callerName: caller?.displayName ?? 'Unknown',
            callerAvatar: caller?.avatarUrl ?? null,
            callerId: userId,
            participants: Array.from(participantIds)
              .filter((id) => id !== targetId)
              .map((id) => ({
                userId: id,
                displayName: userMap.get(id)?.displayName ?? 'Unknown',
                avatarUrl: userMap.get(id)?.avatarUrl ?? null,
              })),
          });
        }

        // Always send push (even if online — socket may not reach suspended/background apps).
        // Fire-and-forget so it doesn't slow down the socket path.
        sendCallPush(targetId, {
          callId,
          conversationId,
          callType: resolvedCallType,
          callerId: userId,
          callerName: caller?.displayName ?? 'Unknown',
          callerAvatar: caller?.avatarUrl,
          isGroup: isGroup ?? false,
        }).catch((err) => {
          logger.error({ err, targetId, callId }, 'Failed to send call push notification');
        });
      }

      // Confirm to the initiator
      socket.emit('call:initiated', { callId, callType: resolvedCallType });

      // For group calls: generate a LiveKit token for the initiator
      if (isGroup) {
        try {
          const callerDisplayName = caller?.displayName ?? undefined;
          const token = await generateCallToken(userId, callId, callerDisplayName);
          socket.emit('call:livekit-token', { callId, token, url: LIVEKIT_URL });
          logger.info({ userId, callId }, 'LiveKit token sent to initiator');
        } catch (err) {
          logger.error({ err, callId }, 'Failed to generate LiveKit token for initiator');
        }
      }

      // Server-side timeout: clean up if nobody answers
      const timeout = setTimeout(async () => {
        const call = callState.getCall(callId);
        if (call && !call.answeredAt) {
          try {
            io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: 'timeout' });
            const sockets = await io.in(`call:${callId}`).fetchSockets();
            for (const s of sockets) s.leave(`call:${callId}`);

            for (const targetId of targetUserIds) {
              io.to(`user:${targetId}`).emit('call:missed', {
                callId,
                conversationId,
                callType: resolvedCallType,
                callerName: caller?.displayName ?? 'Unknown',
                callerAvatar: caller?.avatarUrl ?? null,
              });

              sendMissedCallNotification(targetId, {
                callId,
                conversationId,
                callType: resolvedCallType,
                callerId: userId,
                callerName: caller?.displayName ?? 'Unknown',
                callerAvatar: caller?.avatarUrl,
              }).catch((err) => {
                logger.error({ err, targetId, callId }, 'Failed to send missed call notification');
              });
            }

            try {
              await prisma.conversation.update({
                where: { id: conversationId },
                data: { updatedAt: new Date() },
              });
            } catch (dbErr) {
              logger.error({ dbErr, callId, conversationId }, 'Failed to bump conversation updatedAt on missed call');
            }

            logger.info({ callId }, 'Call timed out server-side (no answer)');
          } finally {
            // Always clean up call state, even if notifications fail
            callState.cleanup(callId);
            callState.timeouts.delete(callId);
          }
        } else {
          callState.timeouts.delete(callId);
        }
      }, CALL_TIMEOUT_MS);
      callState.setTimeout(callId, timeout);

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
      const call = callState.getCall(callId);
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
      const call = callState.getCall(callId);

      if (!call || !call.participantIds.has(userId)) {
        socket.emit('call:error', { message: 'Call not found' });
        return;
      }

      // First-answer-wins lock for 1-on-1 calls: if another device already
      // answered, reject this duplicate answer so we don't open two P2P
      // sessions. For group calls multiple participants can answer.
      if (!call.isGroup && call.answeredAt) {
        socket.emit('call:error', {
          message: 'Call already answered on another device',
          code: 'ALREADY_ANSWERED',
        });
        return;
      }

      callState.mapUserToCall(userId, callId);
      socket.join(`call:${callId}`);
      const firstAnswer = !call.answeredAt;
      if (firstAnswer) call.answeredAt = new Date();
      callState.clearTimeout(callId);

      // Tell the answerer's other signed-in devices to stop ringing.
      // socket.to('user:${userId}') automatically excludes this socket.
      socket.to(`user:${userId}`).emit('call:cancel', {
        callId,
        reason: 'answered_elsewhere',
      });

      // Update CallLog to COMPLETED
      try {
        await prisma.callLog.update({
          where: { callId },
          data: { status: 'COMPLETED' },
        });
      } catch (dbErr) {
        logger.error({ dbErr, callId }, 'Failed to update CallLog on answer');
      }

      // Fetch answerer's display info for event payloads
      const answerer = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, avatarUrl: true },
      });

      if (call.isGroup) {
        // Group call: generate LiveKit token for the answering user
        try {
          const token = await generateCallToken(userId, callId, answerer?.displayName ?? undefined);
          socket.emit('call:livekit-token', { callId, token, url: LIVEKIT_URL });
          logger.info({ userId, callId }, 'LiveKit token sent to answering participant');
        } catch (err) {
          logger.error({ err, callId }, 'Failed to generate LiveKit token for answering participant');
        }

        // Notify the initiator with isLiveKit flag
        io.to(`user:${call.initiatorId}`).emit('call:answered', {
          callId,
          userId,
          displayName: answerer?.displayName ?? 'Unknown',
          avatarUrl: answerer?.avatarUrl ?? null,
          isLiveKit: true,
        });

        // Notify other already-joined participants
        socket.to(`call:${callId}`).emit('call:participant-joined', {
          callId,
          userId,
          displayName: answerer?.displayName ?? 'Unknown',
          avatarUrl: answerer?.avatarUrl ?? null,
        });
      } else {
        // 1-on-1 call: notify the initiator (P2P handshake follows)
        io.to(`user:${call.initiatorId}`).emit('call:answered', {
          callId,
          userId,
          displayName: answerer?.displayName ?? 'Unknown',
          avatarUrl: answerer?.avatarUrl ?? null,
        });
      }

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
      const call = callState.getCall(callId);

      if (!call || !call.participantIds.has(userId)) return;

      io.to(`user:${call.initiatorId}`).emit('call:rejected', {
        callId,
        userId,
      });

      // Dismiss incoming UI on the rejecter's other devices.
      socket.to(`user:${userId}`).emit('call:cancel', {
        callId,
        reason: 'rejected_elsewhere',
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
        callState.cleanup(callId);
      } else {
        call.participantIds.delete(userId);
        callState.unmapUser(userId);

        // If only the initiator is left, clean up the call entirely
        if (call.participantIds.size <= 1) {
          io.to(`user:${call.initiatorId}`).emit('call:ended', { callId, endedBy: 'all_rejected' });
          const remainingSockets = await io.in(`call:${callId}`).fetchSockets();
          for (const s of remainingSockets) s.leave(`call:${callId}`);
          callState.cleanup(callId);
        }
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
      const call = callState.getCall(callId);

      if (!call) {
        logger.warn({ callId, userId, type }, 'call:signal dropped — call not found in activeCalls');
        return;
      }
      if (!call.participantIds.has(userId)) {
        logger.warn({ callId, userId, type }, 'call:signal dropped — sender not in participantIds');
        return;
      }

      // Group calls use LiveKit SFU — no P2P signal relay needed
      if (call.isGroup) return;

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
   * call:request-token — Request a LiveKit token for a group call.
   * Used for token refresh or late-join scenarios.
   */
  socket.on('call:request-token', async (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = callState.getCall(callId);

      if (!call || !call.participantIds.has(userId) || !call.isGroup) {
        socket.emit('call:error', { message: 'Cannot generate token' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true },
      });
      const token = await generateCallToken(userId, callId, user?.displayName ?? undefined);
      socket.emit('call:livekit-token', { callId, token, url: LIVEKIT_URL });
      logger.info({ userId, callId }, 'LiveKit token refreshed');
    } catch (error) {
      logger.error({ error, userId }, 'Error generating call token');
      socket.emit('call:error', { message: 'Failed to generate token' });
    }
  });

  /**
   * call:end — End the call. Notifies all participants.
   */
  socket.on('call:end', async (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = callState.getCall(callId);
      if (!call) return;

      // If the caller hangs up before anyone answered, tell every target's
      // devices to dismiss the incoming-call UI + every sibling device of
      // the caller to stop its "calling..." screen.
      if (!call.answeredAt) {
        for (const targetId of call.participantIds) {
          if (targetId === call.initiatorId) continue;
          io.to(`user:${targetId}`).emit('call:cancel', {
            callId,
            reason: 'caller_cancelled',
          });
        }
        socket.to(`user:${userId}`).emit('call:cancel', {
          callId,
          reason: 'cancelled_elsewhere',
        });
      }

      socket.to(`call:${callId}`).emit('call:ended', { callId, endedBy: userId });
      await finalizeCallEnd(io, callId, call);
      logger.info({ userId, callId }, 'Call ended');
    } catch (error) {
      logger.error({ error, userId }, 'Error ending call');
    }
  });

  /**
   * call:reaction — Send an emoji reaction during a call.
   * Broadcasts to all other participants in the call room.
   */
  socket.on('call:reaction', async (data: { callId: string; emoji: string }) => {
    try {
      const { callId, emoji } = data;
      if (!callId || !emoji) return;

      const call = callState.getCall(callId);
      if (!call || !call.participantIds.has(userId)) return;

      // Fetch sender's display name
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true },
      });

      // Broadcast to all other participants in the call room
      socket.to(`call:${callId}`).emit('call:reaction', {
        userId,
        displayName: user?.displayName ?? 'Unknown',
        emoji,
      });
    } catch (error) {
      logger.error({ error, userId }, 'Error sending call reaction');
    }
  });

  /**
   * On disconnect, start a grace period before ending the call.
   * Mobile sockets frequently drop briefly (transport switch, background,
   * network change). If the user reconnects within DISCONNECT_GRACE_MS,
   * the call stays alive.
   */
  socket.on('disconnect', () => {
    const callId = callState.getUserCallId(userId);
    if (!callId) return;

    const call = callState.getCall(callId);
    if (!call) return;

    logger.info({ userId, callId, graceSec: DISCONNECT_GRACE_MS / 1000 }, 'User disconnected during call — starting grace period');

    const timeout = setTimeout(async () => {
      callState.disconnectGrace.delete(userId);

      // Re-check: the call might have ended normally during the grace period
      const currentCall = callState.getCall(callId);
      if (!currentCall) return;

      if (currentCall.isGroup && currentCall.participantIds.size > 2) {
        currentCall.participantIds.delete(userId);
        callState.unmapUser(userId);
        io.to(`call:${callId}`).emit('call:participant-left', { callId, userId });
      } else {
        // Grace period expired — end the call
        io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: userId });
        await finalizeCallEnd(io, callId, currentCall);
        logger.info({ userId, callId }, 'Call ended after disconnect grace period expired');
      }
    }, DISCONNECT_GRACE_MS);

    callState.disconnectGrace.set(userId, { timeout, callId });
  });
}

