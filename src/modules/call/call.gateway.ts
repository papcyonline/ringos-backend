import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { sendCallPush, sendCallCancelPush, sendMissedCallNotification } from '../notification/notification.service';
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
 * Receipt-driven push retry window. If we haven't received call:ringing from
 * a target within this window, we resend the VoIP push once. After a second
 * window with still no ack, we emit call:unavailable to the caller. Two
 * 5-second windows fits comfortably inside the 45s call timeout.
 */
const PUSH_ACK_WINDOW_MS = 5_000;

/**
 * Pre-push gate. We always emit `call:incoming` over the socket first; if the
 * receiver's WebSocket is alive (foreground or recently-active app), the
 * frontend acks with `call:ringing` within ~25-100ms and we skip sending the
 * VoIP push entirely — the in-app IncomingCallOverlay handles the UX, and we
 * avoid the brief CallKit flash that iOS forces every VoIP push to display
 * (Apple won't let us suppress it once the push lands; the only fix is to
 * not send it). 500ms covers cross-region socket round-trips with comfortable
 * margin (cellular networks, weak Wi-Fi, app-foregrounding-mid-call edges)
 * while keeping the wake-from-sleep latency for genuinely-offline receivers
 * imperceptible. Mirrors the WebSocket-first / push-fallback pattern used by
 * Telegram, Signal, and Wazo-style platforms.
 */
const PUSH_GATE_MS = 500;

/**
 * Per-instance retry-timer registry. Timers can't cross Node processes, but
 * the timer's callback re-checks authoritative Redis state before acting,
 * so a timer firing after a teardown on another instance is harmless.
 * Keyed by `${callId}:${targetUserId}`.
 */
const pushRetryTimers = new Map<string, NodeJS.Timeout>();

function clearPushRetryTimers(callId: string): void {
  const prefix = `${callId}:`;
  for (const [key, timer] of pushRetryTimers) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      pushRetryTimers.delete(key);
    }
  }
}

function clearPushRetryTimer(callId: string, userId: string): void {
  const key = `${callId}:${userId}`;
  const timer = pushRetryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pushRetryTimers.delete(key);
  }
}

/**
 * After firing the initial sendCallPush, schedule one retry if the recipient
 * hasn't acked ringing within PUSH_ACK_WINDOW_MS. After a second window with
 * still no ack, emit call:unavailable to the caller so they're not stuck on
 * a "ringing forever" screen waiting for the 45s timeout.
 *
 * iOS CallKit dedups by callId so resending is a safe idempotent retry —
 * the recipient won't see two CallKit UIs.
 */
function schedulePushRetry(
  io: Server,
  callId: string,
  targetId: string,
  initiatorId: string,
  pushPayload: Parameters<typeof sendCallPush>[1],
): void {
  const key = `${callId}:${targetId}`;
  const firstTimer = setTimeout(async () => {
    pushRetryTimers.delete(key);
    try {
      if (await callState.hasRingingAcked(callId, targetId)) return;
      const stillActive = await callState.getCall(callId);
      if (!stillActive || stillActive.answeredAt) return;

      logger.info({ callId, targetId }, 'Push not acked within window — resending');
      await callState.markPushEnqueued(callId, targetId, Date.now());
      sendCallPush(targetId, pushPayload).catch((err) => {
        logger.error({ err, targetId, callId }, 'Push retry failed');
      });

      // Second window — declare the recipient unreachable if still no ack.
      const secondTimer = setTimeout(async () => {
        pushRetryTimers.delete(key);
        try {
          if (await callState.hasRingingAcked(callId, targetId)) return;
          const call = await callState.getCall(callId);
          if (!call || call.answeredAt) return;
          logger.warn(
            { callId, targetId },
            'Push undelivered after 2 attempts — emitting call:unavailable to caller',
          );
          io.to(`user:${initiatorId}`).emit('call:unavailable', { targetUserId: targetId });
        } catch (err) {
          logger.error({ err, callId, targetId }, 'Push retry second-window callback failed');
        }
      }, PUSH_ACK_WINDOW_MS);
      pushRetryTimers.set(key, secondTimer);
    } catch (err) {
      logger.error({ err, callId, targetId }, 'Push retry first-window callback failed');
    }
  }, PUSH_ACK_WINDOW_MS);
  pushRetryTimers.set(key, firstTimer);
}

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

  clearPushRetryTimers(callId);
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

      // Notify each target user. Targets are independent — fan out in parallel
      // so the per-call latency stays ~PUSH_GATE_MS regardless of group size.
      await Promise.all(targetUserIds.map(async (targetId) => {
        const targetSockets = await io.in(`user:${targetId}`).fetchSockets();
        const isOnline = targetSockets.length > 0;

        logger.info(
          { targetId, socketCount: targetSockets.length, callId, isOnline },
          'Emitting call:incoming to target user room'
        );

        if (isOnline) {
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

          // Wait for the receiver's `call:ringing` ack. Their app acks
          // within ~25-100ms when the socket event arrives, so PUSH_GATE_MS
          // is plenty. If they ack, the in-app overlay handles the UX and
          // we skip the VoIP push (no CallKit flash on iOS).
          const acked = await callState.waitForRingingAck(callId, targetId, PUSH_GATE_MS);
          if (acked) return;
        }

        // Receiver isn't reachable via socket (offline, killed, or socket
        // alive-but-app-frozen — the latter happens briefly on iOS background).
        // Wake their device with a VoIP push (iOS) / FCM data push (Android).
        const pushPayload = {
          callId,
          conversationId,
          callType: resolvedCallType,
          callerId: userId,
          callerName: caller?.displayName ?? 'Unknown',
          callerAvatar: caller?.avatarUrl,
          isGroup: isGroup ?? false,
        };
        // Stamp BEFORE the fire-and-forget so a fast cancel path can see
        // that a push is in flight (used by call:end to suppress a
        // cancel-only VoIP that would race ahead of the original).
        await callState.markPushEnqueued(callId, targetId, Date.now());
        sendCallPush(targetId, pushPayload).catch((err) => {
          logger.error({ err, targetId, callId }, 'Failed to send call push notification');
        });
        // Receipt-driven retry: if the recipient still doesn't ack ringing
        // within PUSH_ACK_WINDOW_MS, resend once. After a second silent
        // window, emit call:unavailable to the caller.
        schedulePushRetry(io, callId, targetId, userId, pushPayload);
      }));

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
          // Race guard: another path (explicit end, disconnect grace) may
          // already be tearing this call down. Skip if we're not first.
          const claimed = await callState.claimTermination(callId);
          if (!claimed) {
            callState.clearUnansweredTimer(callId);
            return;
          }
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

              // Skip the push banner if the receiver's app already saw the
              // incoming-call event (acked ringing). hasRingingAcked is a
              // direct observation of the receiver's app state — far more
              // reliable than the foreground presence room, which races on
              // app launch / background-foreground transitions.
              const seenIncoming = await callState.hasRingingAcked(callId, targetId);

              sendMissedCallNotification(
                targetId,
                {
                  callId,
                  conversationId,
                  callType: resolvedCallType,
                  callerId: userId,
                  callerName: caller?.displayName ?? 'Unknown',
                  callerAvatar: caller?.avatarUrl,
                },
                { skipPush: seenIncoming },
              ).catch((err) => {
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
            clearPushRetryTimers(callId);
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

      // Mark that this target's device confirmed the CallKit/incoming UI
      // fired. From this point onwards, sending a cancel VoIP push to this
      // user is safe — Apple's PushKit policy engine already saw a real
      // CallKit UI for the original.
      await callState.markRinging(callId, userId);
      // Recipient is awake — kill any pending retry timer for them.
      clearPushRetryTimer(callId, userId);

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
      // Also send a VoIP cancel push. Sibling devices may have a suspended
      // socket (iOS backgrounded, CallKit showing) and would otherwise keep
      // ringing until the server-side timeout. The VoIP push dismisses
      // CallKit on iOS even when the Flutter app is killed.
      sendCallCancelPush(userId, callId).catch((err) => {
        logger.error({ err, userId, callId }, 'Failed to send VoIP cancel push to answerer siblings');
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

      // For 1-on-1 rejects, claim termination up front. A second reject
      // (e.g. user taps Decline on two devices simultaneously) or a racing
      // call:end would otherwise double-emit call:rejected + duplicate the
      // CallLog status update.
      if (!call.isGroup) {
        const claimed = await callState.claimTermination(callId);
        if (!claimed) {
          logger.info({ userId, callId }, 'call:reject ignored — already terminating');
          return;
        }
      }

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
        clearPushRetryTimers(callId);
        await callState.cleanup(callId);
      } else {
        await callState.removeParticipant(callId, userId);
        // Re-read to see the trimmed participant set (group participants
        // may be updated concurrently on other instances).
        const trimmed = await callState.getCall(callId);

        // If only the initiator is left, clean up the call entirely.
        // Race guard on the full teardown path (equivalent to call:end).
        if (!trimmed || trimmed.participantIds.size <= 1) {
          const claimed = await callState.claimTermination(callId);
          if (!claimed) {
            logger.info({ userId, callId }, 'group call:reject cleanup skipped — already terminating');
            return;
          }
          io.to(`user:${call.initiatorId}`).emit('call:ended', { callId, endedBy: 'all_rejected' });
          const remainingSockets = await io.in(`call:${callId}`).fetchSockets();
          for (const s of remainingSockets) s.leave(`call:${callId}`);
          clearPushRetryTimers(callId);
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
      const callBefore = await callState.getCall(callId);
      if (!callBefore) return;

      // First-terminator-wins lock. Prevents duplicate missed-call pushes,
      // double room broadcasts, and double CallLog updates when a second
      // call:end arrives (e.g. CallKit end racing the UI end button, or
      // the server-side timeout racing an explicit end).
      const claimed = await callState.claimTermination(callId);
      if (!claimed) {
        logger.info({ userId, callId }, 'call:end ignored — already terminating');
        return;
      }

      // Re-read state AFTER the claim: an answer may have landed between
      // our initial getCall and the claim (e.g. callee tapped Answer in the
      // same tick the caller tapped End). Using the fresh snapshot keeps us
      // from falsely firing the missed-call path against a just-answered call.
      const call = (await callState.getCall(callId)) ?? callBefore;

      // If the caller hangs up before anyone answered, tell every target's
      // devices to dismiss the incoming-call UI + every sibling device of
      // the caller to stop its "calling..." screen. Also fire a missed-call
      // notification so the callee still gets a lock-screen banner (the
      // CallKit ring alone leaves nothing behind once dismissed).
      if (!call.answeredAt) {
        const caller = await prisma.user.findUnique({
          where: { id: call.initiatorId },
          select: { displayName: true, avatarUrl: true },
        });
        for (const targetId of call.participantIds) {
          if (targetId === call.initiatorId) continue;
          io.to(`user:${targetId}`).emit('call:cancel', {
            callId,
            reason: 'caller_cancelled',
          });

          // If the receiver's app already acked ringing, the in-app overlay
          // saw call:cancel above and the missed-call entry will land in
          // their inbox. Sending the VoIP cancel push + FCM banner on top
          // would stack a CallKit toast + system banner — the "double on
          // drop" half of the original report.
          //
          // For receivers that never acked (background/killed/offline) we
          // still need both: the VoIP cancel dismisses CallKit on iOS
          // when the socket is dead, and the FCM banner is the user's
          // only signal that they were called.
          //
          // hasRingingAcked is direct observation — far more reliable than
          // the presence room, which races on launch / lifecycle changes.
          const seenIncoming = await callState.hasRingingAcked(callId, targetId);

          if (!seenIncoming) {
            // Cancel-before-original guard: if we sent the call VoIP push
            // less than 3 seconds ago AND the recipient hasn't confirmed
            // ringing, sending a cancel VoIP now would arrive at APNs
            // alongside (or before) the original. iOS would report a
            // throwaway CallKit and end it in <100ms — Apple's PushKit
            // policy engine treats that as a fake call and silently
            // throttles future VoIP delivery to that device. Better to
            // let the original ring out (recipient sees ~30s of CallKit
            // with no answer) than train Apple to drop our pushes.
            const suppressCancel = await callState.shouldSuppressCancelPush(
              callId,
              targetId,
              3000,
            );
            if (suppressCancel) {
              logger.info(
                { callId, targetId },
                'Suppressing cancel VoIP push — original push still propagating',
              );
            } else {
              sendCallCancelPush(targetId, callId).catch((err) => {
                logger.error({ err, targetId, callId }, 'Failed to send VoIP cancel push');
              });
            }
          }

          io.to(`user:${targetId}`).emit('call:missed', {
            callId,
            conversationId: call.conversationId,
            callType: call.callType,
            callerName: caller?.displayName ?? 'Unknown',
            callerAvatar: caller?.avatarUrl ?? null,
          });
          sendMissedCallNotification(
            targetId,
            {
              callId,
              conversationId: call.conversationId,
              callType: call.callType,
              callerId: call.initiatorId,
              callerName: caller?.displayName ?? 'Unknown',
              callerAvatar: caller?.avatarUrl,
            },
            { skipPush: seenIncoming },
          ).catch((err) => {
            logger.error({ err, targetId, callId }, 'Failed to send missed call notification');
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
        // Grace period expired — end the call. Race guard: another path
        // (explicit call:end, timeout) may already be tearing down.
        const claimed = await callState.claimTermination(callId);
        if (!claimed) {
          logger.info({ userId, callId }, 'Disconnect grace expiry skipped — already terminating');
          return;
        }
        io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: userId });
        await finalizeCallEnd(io, callId, currentCall);
        logger.info({ userId, callId }, 'Call ended after disconnect grace period expired');
      }
    }, DISCONNECT_GRACE_MS);

    callState.setDisconnectGrace(userId, timeout, callId);
  });
}

