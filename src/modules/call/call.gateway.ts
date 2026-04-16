import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { sendCallPush, sendMissedCallNotification } from '../notification/notification.service';
import { checkCallMinutes, addCallMinutes } from '../../shared/usage.service';
import { generateCallToken, LIVEKIT_URL } from './call.livekit';
import { isBlocked } from '../safety/safety.service';
import { ActiveCall, CallStateStore, getCallStateStore } from './call.state.store';
import { callLogWriter } from './call.log.writer';

/**
 * Maximum time (ms) to wait for an answer before cleaning up server-side.
 * Kept marginally higher than the client outgoing timeout so the client
 * (which knows to give up first) drives the "no answer" UX.
 */
const CALL_TIMEOUT_MS = 45_000;

/** Grace period (ms) before ending a call on disconnect. Allows brief reconnections. */
const DISCONNECT_GRACE_MS = 10_000;

/**
 * Shared state across every backend instance (Redis-backed when configured,
 * in-memory otherwise). Wrapped in a proxy so the store is resolved lazily
 * on first access — Redis isn't connected yet at module-eval time, so eager
 * resolution would pick the in-memory fallback even when REDIS_URL is set.
 * See call.state.store.ts for the interface.
 */
const callState: CallStateStore = new Proxy({} as CallStateStore, {
  get(_, prop) {
    const real = getCallStateStore();
    const value = Reflect.get(real, prop);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

/**
 * Shared call-end logic: calculate duration, update DB, track minutes, remove sockets, cleanup state.
 * Used by both the explicit call:end handler and the disconnect grace expiry.
 */
async function finalizeCallEnd(io: Server, callId: string, call: ActiveCall): Promise<void> {
  const now = new Date();
  const durationSecs = call.answeredAt
    ? Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)
    : undefined;

  // Write-behind: queued behind the create + answer-update for this callId.
  // The chain guarantees end-update lands AFTER answer-update.
  callLogWriter.enqueue(callId, () =>
    prisma.callLog.update({
      where: { callId },
      data: { endedAt: now, ...(durationSecs !== undefined ? { durationSecs } : {}) },
    }),
  );

  if (durationSecs !== undefined && durationSecs > 0) {
    for (const pid of call.participantIds) {
      addCallMinutes(pid, durationSecs).catch((err) => {
        logger.error({ err, userId: pid, callId }, 'Failed to track call minutes');
      });
    }
  }

  const sockets = await io.in(`call:${callId}`).fetchSockets();
  for (const s of sockets) s.leave(`call:${callId}`);

  await callState.cleanup(callId);
}

/** Check whether a user is currently in an active call. */
export async function isUserInCall(userId: string): Promise<boolean> {
  return callState.isUserInCall(userId);
}

/**
 * Create a call entry that is already "answered" — no ringing phase.
 * Used by Spotlight direct-connect to skip the incoming-call flow.
 * Returns the generated callId.
 */
export async function createDirectCall(params: {
  conversationId: string;
  initiatorId: string;
  participantIds: string[];
  callType: 'AUDIO' | 'VIDEO';
}): Promise<string> {
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
  await callState.addCall(call);
  await Promise.all(params.participantIds.map((pid) => callState.mapUserToCall(pid, callId)));
  return callId;
}

export async function registerCallHandlers(io: Server, socket: Socket): Promise<void> {
  const userId: string = (socket as any).userId;

  // ── Reconnection: cancel pending disconnect grace if user reconnects ──
  // Only works when the user reconnects to the SAME backend instance. When
  // they reconnect to a different instance, this call returns undefined; the
  // original instance's grace timer still runs but its callback re-checks
  // socket presence via Socket.IO's Redis adapter (see disconnect handler),
  // so the call isn't ended on a false positive.
  // Wrapped in try/catch because registerCallHandlers' returned promise is
  // not awaited by the caller — any rejection would otherwise be unhandled
  // and kill the process under Node's strict policy.
  try {
    const pending = callState.takeDisconnectGrace(userId);
    if (pending) {
      const call = await callState.getCall(pending.callId);
      if (call) {
        socket.join(`call:${pending.callId}`);
        logger.info({ userId, callId: pending.callId }, 'User reconnected during call — grace period cancelled');
      }
    }
  } catch (err) {
    logger.error({ err, userId }, 'Reconnect-grace check failed — continuing with handler registration');
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
      const staleCallId = await callState.getUserCallId(userId);
      if (staleCallId) {
        const staleCall = await callState.getCall(staleCallId);
        if (staleCall) {
          if (!staleCall.answeredAt) {
            await callState.cleanup(staleCallId);
          } else {
            socket.emit('call:error', { message: 'You are already in a call' });
            return;
          }
        } else {
          await callState.unmapUser(userId);
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

      // ── Pre-ring checks ───────────────────────────────────────────────
      // Every check below is defensive: on any query error we LOG and
      // continue, never block a legitimate call. Each check runs
      // independently so a failure in one doesn't skip the others.

      // Verify each target is also an active participant. Skip for group
      // calls (group membership is the caller's responsibility).
      if (!(isGroup ?? false)) {
        try {
          const targetParticipations = await prisma.conversationParticipant.findMany({
            where: { conversationId, userId: { in: targetUserIds } },
            select: { userId: true, leftAt: true },
          });
          const activeTargets = new Set(
            targetParticipations.filter((p) => p.leftAt == null).map((p) => p.userId),
          );
          const droppedTargets = targetUserIds.filter((id) => !activeTargets.has(id));
          // Only reject if we definitively found a row saying the user left.
          // Missing rows → let it ring (could be a channel DM race / cache).
          const knownLeft = targetParticipations.filter((p) => p.leftAt != null).map((p) => p.userId);
          if (knownLeft.length > 0 && knownLeft.length === targetUserIds.length) {
            logger.warn({ userId, conversationId, knownLeft }, 'Rejecting call: all targets have left conversation');
            socket.emit('call:error', {
              message: 'One or more recipients are no longer in this conversation',
              code: 'TARGET_NOT_PARTICIPANT',
              droppedTargets: knownLeft,
            });
            return;
          }
          if (droppedTargets.length > 0) {
            logger.warn({ userId, conversationId, droppedTargets }, 'call:initiate targets missing participant rows — ringing anyway');
          }
        } catch (err) {
          logger.error({ err, userId, conversationId }, 'Target-participation check failed — ringing anyway');
        }
      }

      // Block check — 1-on-1 only. On query failure, let the call proceed.
      if (!(isGroup ?? false) && targetUserIds.length === 1) {
        try {
          const [targetId] = targetUserIds;
          const blocked = await isBlocked(userId, targetId);
          if (blocked) {
            logger.info({ userId, targetId: targetUserIds[0] }, 'Rejecting call: users are blocked');
            socket.emit('call:error', {
              message: 'Cannot call this user',
              code: 'BLOCKED',
            });
            return;
          }
        } catch (err) {
          logger.error({ err, userId }, 'Block check failed — ringing anyway');
        }
      }

      // Busy check — only block if the target is in an ANSWERED call. Stale
      // unanswered entries (e.g. from a crashed session) shouldn't prevent
      // new calls from coming through.
      if (targetUserIds.length === 1) {
        try {
          const [targetId] = targetUserIds;
          const busyCallId = await callState.getUserCallId(targetId);
          if (busyCallId) {
            const busyCall = await callState.getCall(busyCallId);
            if (busyCall && busyCall.answeredAt) {
              logger.info({ userId, targetId, busyCallId }, 'Rejecting call: target is in another answered call');
              socket.emit('call:busy', {
                busyUserIds: [targetId],
                code: 'BUSY',
              });
              return;
            }
          }
        } catch (err) {
          logger.error({ err, userId }, 'Busy check failed — ringing anyway');
        }
      }

      // Unavailable check — only short-circuit if BOTH token queries
      // succeeded AND both returned zero AND there's no live socket.
      // A failed query should never cause a spurious "unavailable".
      if (targetUserIds.length === 1) {
        try {
          const [targetId] = targetUserIds;
          const results = await Promise.allSettled([
            io.in(`user:${targetId}`).fetchSockets(),
            prisma.voipToken.count({ where: { userId: targetId } }),
            prisma.fcmToken.count({ where: { userId: targetId } }),
          ]);
          const socketsOk = results[0].status === 'fulfilled';
          const voipOk = results[1].status === 'fulfilled';
          const fcmOk = results[2].status === 'fulfilled';
          const sockets = socketsOk ? (results[0] as PromiseFulfilledResult<any[]>).value : [];
          const voip = voipOk ? (results[1] as PromiseFulfilledResult<number>).value : 1;
          const fcm = fcmOk ? (results[2] as PromiseFulfilledResult<number>).value : 1;

          if (socketsOk && voipOk && fcmOk && sockets.length === 0 && voip === 0 && fcm === 0) {
            logger.info({ userId, targetId }, 'Rejecting call: target has no devices registered');
            socket.emit('call:unavailable', { targetUserId: targetId });
            return;
          }
        } catch (err) {
          logger.error({ err, userId }, 'Unavailable check failed — ringing anyway');
        }
      }

      const caller = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, avatarUrl: true },
      });

      const callId = randomUUID();
      const participantIds = new Set<string>([userId, ...targetUserIds]);

      await callState.addCall({
        callId,
        conversationId,
        initiatorId: userId,
        participantIds,
        isGroup: isGroup ?? false,
        callType: resolvedCallType,
      });

      await callState.mapUserToCall(userId, callId);

      // Create CallLog with initial MISSED status. Write-behind so the
      // signalling path doesn't block on Prisma's pool under burst load —
      // history persistence is not on the critical path of the call.
      // First op in this callId's chain; subsequent updates (answer/reject/
      // end) queue behind it so they always observe the row.
      callLogWriter.enqueue(callId, () =>
        prisma.callLog.create({
          data: {
            callId,
            conversationId,
            initiatorId: userId,
            callType: resolvedCallType,
            status: 'MISSED',
          },
        }),
      );

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

      // Generate a LiveKit token for the initiator. ALL calls (1-on-1 and
      // group) now route through LiveKit SFU — no more P2P WebRTC branch.
      try {
        const callerDisplayName = caller?.displayName ?? undefined;
        const token = await generateCallToken(userId, callId, callerDisplayName);
        socket.emit('call:livekit-token', { callId, token, url: LIVEKIT_URL });
        logger.info({ userId, callId }, 'LiveKit token sent to initiator');
      } catch (err) {
        logger.error({ err, callId }, 'Failed to generate LiveKit token for initiator');
      }

      // Server-side timeout: clean up if nobody answers. Re-reads call state
      // from the store inside the callback so an answer on a different
      // backend instance (which flipped answeredAt in Redis) suppresses the
      // missed-call path here.
      const timeout = setTimeout(async () => {
        const call = await callState.getCall(callId);
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
            // Always clean up call state, even if notifications fail.
            // clearUnansweredTimer is implicit in cleanup().
            await callState.cleanup(callId);
          }
        } else {
          callState.clearUnansweredTimer(callId);
        }
      }, CALL_TIMEOUT_MS);
      callState.setUnansweredTimer(callId, timeout);

      logger.info({ userId, callId, targetUserIds, callType: resolvedCallType }, 'Call initiated');
    } catch (error) {
      logger.error({ error, userId }, 'Error initiating call');
      socket.emit('call:error', { message: 'Failed to initiate call' });
    }
  });

  /**
   * call:ringing — The target's phone is ringing. Relay to the caller.
   */
  socket.on('call:ringing', async (data: { callId: string }) => {
    try {
      const { callId } = data;
      const call = await callState.getCall(callId);
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
      const call = await callState.getCall(callId);

      if (!call || !call.participantIds.has(userId)) {
        socket.emit('call:error', { message: 'Call not found' });
        return;
      }

      // First-answer-wins lock — atomic across backend instances when the
      // store is Redis-backed. For group calls, later answerers are allowed
      // to join; markAnswered returns false for them but that's fine.
      const firstAnswer = await callState.markAnswered(callId, userId, new Date());
      if (!call.isGroup && !firstAnswer) {
        socket.emit('call:error', {
          message: 'Call already answered on another device',
          code: 'ALREADY_ANSWERED',
        });
        return;
      }

      await callState.mapUserToCall(userId, callId);
      socket.join(`call:${callId}`);
      if (firstAnswer) callState.clearUnansweredTimer(callId);

      // Keep the local `call` snapshot consistent for downstream branches.
      if (firstAnswer && !call.answeredAt) call.answeredAt = new Date();

      // Tell the answerer's other signed-in devices to stop ringing.
      // socket.to('user:${userId}') automatically excludes this socket.
      socket.to(`user:${userId}`).emit('call:cancel', {
        callId,
        reason: 'answered_elsewhere',
      });

      // Update CallLog to COMPLETED — write-behind, ordered after the
      // initial create.
      callLogWriter.enqueue(callId, () =>
        prisma.callLog.update({
          where: { callId },
          data: { status: 'COMPLETED' },
        }),
      );

      // Fetch answerer's display info for event payloads
      const answerer = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, avatarUrl: true },
      });

      // Generate LiveKit token for the answering user. ALL calls route
      // through LiveKit SFU now — no P2P WebRTC branch.
      try {
        const token = await generateCallToken(userId, callId, answerer?.displayName ?? undefined);
        socket.emit('call:livekit-token', { callId, token, url: LIVEKIT_URL });
        logger.info({ userId, callId }, 'LiveKit token sent to answering participant');
      } catch (err) {
        logger.error({ err, callId }, 'Failed to generate LiveKit token for answering participant');
      }

      // Notify the initiator
      io.to(`user:${call.initiatorId}`).emit('call:answered', {
        callId,
        userId,
        displayName: answerer?.displayName ?? 'Unknown',
        avatarUrl: answerer?.avatarUrl ?? null,
        isLiveKit: true,
      });

      // For group calls: also notify already-joined participants
      if (call.isGroup) {
        socket.to(`call:${callId}`).emit('call:participant-joined', {
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
      const call = await callState.getCall(callId);

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

      // Update CallLog to REJECTED — write-behind, ordered after create.
      callLogWriter.enqueue(callId, () =>
        prisma.callLog.update({
          where: { callId },
          data: { status: 'REJECTED', endedAt: new Date() },
        }),
      );

      // For 1-on-1 calls, clean up immediately
      if (!call.isGroup) {
        // Make all sockets leave the call room
        const rejectSockets = await io.in(`call:${callId}`).fetchSockets();
        for (const s of rejectSockets) s.leave(`call:${callId}`);
        await callState.cleanup(callId);
      } else {
        await callState.removeParticipant(callId, userId);
        // Re-read to see the trimmed participant set (group participants
        // may be updated concurrently on other instances).
        const trimmed = await callState.getCall(callId);

        // If only the initiator is left, clean up the call entirely
        if (!trimmed || trimmed.participantIds.size <= 1) {
          io.to(`user:${call.initiatorId}`).emit('call:ended', { callId, endedBy: 'all_rejected' });
          const remainingSockets = await io.in(`call:${callId}`).fetchSockets();
          for (const s of remainingSockets) s.leave(`call:${callId}`);
          await callState.cleanup(callId);
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
      const call = await callState.getCall(callId);

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
      const call = await callState.getCall(callId);

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
      const call = await callState.getCall(callId);
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

      const call = await callState.getCall(callId);
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
  socket.on('disconnect', async () => {
    const callId = await callState.getUserCallId(userId);
    if (!callId) return;

    const call = await callState.getCall(callId);
    if (!call) return;

    logger.info({ userId, callId, graceSec: DISCONNECT_GRACE_MS / 1000 }, 'User disconnected during call — starting grace period');

    const timeout = setTimeout(async () => {
      callState.takeDisconnectGrace(userId);

      // Cross-instance reconnection check: Socket.IO's Redis adapter lets
      // fetchSockets see sockets on every instance. If the user reconnected
      // on a different process, skip the end-of-call path.
      try {
        const liveSockets = await io.in(`user:${userId}`).fetchSockets();
        if (liveSockets.length > 0) {
          logger.info({ userId, callId }, 'Disconnect grace cancelled — user has live socket(s) on another instance');
          return;
        }
      } catch (err) {
        logger.warn({ err, userId, callId }, 'fetchSockets failed during disconnect grace — continuing with end');
      }

      // Re-read state: call may have ended normally on another instance.
      const currentCall = await callState.getCall(callId);
      if (!currentCall) return;

      if (currentCall.isGroup && currentCall.participantIds.size > 2) {
        await callState.removeParticipant(callId, userId);
        io.to(`call:${callId}`).emit('call:participant-left', { callId, userId });
      } else {
        // Grace period expired — end the call
        io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: userId });
        await finalizeCallEnd(io, callId, currentCall);
        logger.info({ userId, callId }, 'Call ended after disconnect grace period expired');
      }
    }, DISCONNECT_GRACE_MS);

    callState.setDisconnectGrace(userId, timeout, callId);
  });
}

