/**
 * Call state abstraction.
 *
 * Two interchangeable implementations:
 *   - InMemoryCallStateStore: single-process, zero-dependency. Preserves the
 *     original behavior verbatim when Redis is not configured.
 *   - RedisCallStateStore: shared across every backend instance via Redis.
 *     Enables horizontal scaling — any instance can read/update any call.
 *
 * Local per-instance concerns (setTimeout handles for unanswered-call and
 * disconnect-grace timers) intentionally stay in-process on both stores.
 * Timer references can't be serialized; cross-instance correctness is
 * achieved instead by re-reading authoritative state (Redis + socket.io
 * adapter room-membership) inside the timer callback.
 *
 * SRP: this module only holds state. Broadcasting, business rules, DB writes,
 * and timer *callbacks* live in call.gateway.ts — here we only manage the
 * handle lifecycle.
 */

import type Redis from 'ioredis';
import { getRedis } from '../../shared/redis.service';
import { logger } from '../../shared/logger';

export interface ActiveCall {
  callId: string;
  conversationId: string;
  initiatorId: string;
  participantIds: Set<string>;
  isGroup: boolean;
  callType: 'AUDIO' | 'VIDEO';
  answeredAt?: Date;
}

export interface CallStateStore {
  // ── Authoritative state (shared across instances when Redis-backed) ──
  isUserInCall(userId: string): Promise<boolean>;
  getCall(callId: string): Promise<ActiveCall | undefined>;
  getUserCallId(userId: string): Promise<string | undefined>;
  addCall(call: ActiveCall): Promise<void>;
  mapUserToCall(userId: string, callId: string): Promise<void>;
  unmapUser(userId: string): Promise<void>;
  /**
   * Atomic first-answer lock. Returns true iff `userId` is the first caller
   * to answer this call. Subsequent calls return false even if they arrive
   * simultaneously on different backend instances.
   *
   * For group calls this is always allowed to succeed since multiple
   * participants may answer; the gateway should skip calling this method
   * entirely for groups.
   */
  markAnswered(callId: string, userId: string, answeredAt: Date): Promise<boolean>;
  /**
   * Atomic termination claim. Returns true iff this caller is the first to
   * initiate cleanup for `callId`. Subsequent callers (e.g. a double-tap
   * hang-up, a CallKit-driven end that races the UI's end button, a
   * disconnect-grace expiry that races an explicit end) return false and
   * MUST skip all side effects (room broadcasts, missed-call pushes,
   * CallLog updates) to avoid duplicate cleanup.
   */
  claimTermination(callId: string): Promise<boolean>;
  /** Remove all state for a call, including each participant's user→call map. */
  cleanup(callId: string): Promise<void>;
  /** Remove just this participant's user→call mapping (group-call leave). */
  removeParticipant(callId: string, userId: string): Promise<void>;

  // ── Push delivery tracking (per call × target) ──
  // Used to suppress cancel-only VoIP pushes that would arrive in the silent
  // propagation window BEFORE the original push lands. The cancel-before-
  // original sequence makes iOS report a throwaway CallKit and end it in
  // <100ms, which Apple's PushKit policy engine treats as a fake call and
  // silently throttles future VoIP delivery to the recipient's device.
  /** Stamp the moment sendCallPush was enqueued for `userId`. */
  markPushEnqueued(callId: string, userId: string, at: number): Promise<void>;
  /** Mark that the recipient confirmed CallKit/incoming UI fired (via call:ringing). */
  markRinging(callId: string, userId: string): Promise<void>;
  /** Has `userId` acked ringing for `callId`? Used by the receipt-driven retry. */
  hasRingingAcked(callId: string, userId: string): Promise<boolean>;
  /**
   * True iff a VoIP push was enqueued for `userId` within `windowMs` AND
   * the recipient has NOT acked ringing. The gateway's call:end cancel
   * branch must skip sendCallCancelPush in that window — let the original
   * ring out instead of training Apple to throttle us.
   */
  shouldSuppressCancelPush(callId: string, userId: string, windowMs: number): Promise<boolean>;

  // ── Per-instance timer handles (not shared; see module comment) ──
  setUnansweredTimer(callId: string, handle: NodeJS.Timeout): void;
  clearUnansweredTimer(callId: string): void;
  setDisconnectGrace(userId: string, handle: NodeJS.Timeout, callId: string): void;
  /**
   * Cancel and return any pending disconnect-grace entry for this user.
   * Used when the user reconnects and we want to abort the grace-end.
   */
  takeDisconnectGrace(userId: string): { callId: string } | undefined;
}

// ── In-memory implementation ────────────────────────────────────────────────

class InMemoryCallStateStore implements CallStateStore {
  private readonly calls = new Map<string, ActiveCall>();
  private readonly userCall = new Map<string, string>();
  private readonly terminating = new Set<string>();
  private readonly unansweredTimers = new Map<string, NodeJS.Timeout>();
  private readonly disconnectTimers = new Map<string, { timeout: NodeJS.Timeout; callId: string }>();
  // Push delivery tracking — `${callId}:${userId}` keys
  private readonly pushEnqueuedAt = new Map<string, number>();
  private readonly ringingAcked = new Set<string>();

  async isUserInCall(userId: string): Promise<boolean> {
    return this.userCall.has(userId);
  }

  async getCall(callId: string): Promise<ActiveCall | undefined> {
    return this.calls.get(callId);
  }

  async getUserCallId(userId: string): Promise<string | undefined> {
    return this.userCall.get(userId);
  }

  async addCall(call: ActiveCall): Promise<void> {
    this.calls.set(call.callId, call);
  }

  async mapUserToCall(userId: string, callId: string): Promise<void> {
    this.userCall.set(userId, callId);
  }

  async unmapUser(userId: string): Promise<void> {
    this.userCall.delete(userId);
  }

  async markAnswered(callId: string, userId: string, answeredAt: Date): Promise<boolean> {
    const call = this.calls.get(callId);
    if (!call) return false;
    if (call.answeredAt) return false;
    call.answeredAt = answeredAt;
    return true;
  }

  async claimTermination(callId: string): Promise<boolean> {
    if (this.terminating.has(callId)) return false;
    if (!this.calls.has(callId)) return false;
    this.terminating.add(callId);
    return true;
  }

  async cleanup(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    this.terminating.delete(callId);
    if (!call) return;
    this.clearUnansweredTimer(callId);
    for (const pid of call.participantIds) {
      this.userCall.delete(pid);
      const k = `${callId}:${pid}`;
      this.pushEnqueuedAt.delete(k);
      this.ringingAcked.delete(k);
    }
    this.calls.delete(callId);
  }

  async markPushEnqueued(callId: string, userId: string, at: number): Promise<void> {
    this.pushEnqueuedAt.set(`${callId}:${userId}`, at);
  }

  async markRinging(callId: string, userId: string): Promise<void> {
    this.ringingAcked.add(`${callId}:${userId}`);
  }

  async hasRingingAcked(callId: string, userId: string): Promise<boolean> {
    return this.ringingAcked.has(`${callId}:${userId}`);
  }

  async shouldSuppressCancelPush(
    callId: string,
    userId: string,
    windowMs: number,
  ): Promise<boolean> {
    const key = `${callId}:${userId}`;
    if (this.ringingAcked.has(key)) return false;
    const at = this.pushEnqueuedAt.get(key);
    if (at == null) return false;
    return Date.now() - at < windowMs;
  }

  async removeParticipant(callId: string, userId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call) call.participantIds.delete(userId);
    this.userCall.delete(userId);
  }

  setUnansweredTimer(callId: string, handle: NodeJS.Timeout): void {
    const existing = this.unansweredTimers.get(callId);
    if (existing) clearTimeout(existing);
    this.unansweredTimers.set(callId, handle);
  }

  clearUnansweredTimer(callId: string): void {
    const existing = this.unansweredTimers.get(callId);
    if (existing) {
      clearTimeout(existing);
      this.unansweredTimers.delete(callId);
    }
  }

  setDisconnectGrace(userId: string, handle: NodeJS.Timeout, callId: string): void {
    const existing = this.disconnectTimers.get(userId);
    if (existing) clearTimeout(existing.timeout);
    this.disconnectTimers.set(userId, { timeout: handle, callId });
  }

  takeDisconnectGrace(userId: string): { callId: string } | undefined {
    const existing = this.disconnectTimers.get(userId);
    if (!existing) return undefined;
    clearTimeout(existing.timeout);
    this.disconnectTimers.delete(userId);
    return { callId: existing.callId };
  }
}

// ── Redis-backed implementation ─────────────────────────────────────────────

// TTL covers: ringing window + reasonable max call duration + slack. If a
// backend instance dies mid-call, Redis auto-reclaims the keys so they don't
// leak forever. Calls in progress longer than this TTL are extremely rare
// and will simply stop being reachable via lookup — real WebRTC/LiveKit
// media keeps flowing independent of signaling state.
const CALL_KEY_TTL_SECONDS = 2 * 60 * 60; // 2 hours

const callKey = (callId: string) => `call:${callId}`;
const userCallKey = (userId: string) => `user_call:${userId}`;
const answeredLockKey = (callId: string) => `call:${callId}:answered`;
const terminatingLockKey = (callId: string) => `call:${callId}:terminating`;
const pushEnqueuedKey = (callId: string, userId: string) => `call:${callId}:push:${userId}`;
const ringingAckedKey = (callId: string, userId: string) => `call:${callId}:rang:${userId}`;
// 60s covers any realistic ringing window; we only ever check within the
// first 3s but a longer TTL is safer than tight coupling to the check window.
const PUSH_TRACKING_TTL_SECONDS = 60;
// Short TTL: just long enough for cleanup to finish + a safety margin.
// After cleanup() runs we DEL the key anyway, so TTL is purely a failsafe
// against a crash between claim and cleanup.
const TERMINATING_LOCK_TTL_SECONDS = 60;

interface SerializedCall {
  callId: string;
  conversationId: string;
  initiatorId: string;
  participantIds: string[];
  isGroup: boolean;
  callType: 'AUDIO' | 'VIDEO';
  answeredAt?: string; // ISO
}

function serialize(call: ActiveCall): string {
  const payload: SerializedCall = {
    callId: call.callId,
    conversationId: call.conversationId,
    initiatorId: call.initiatorId,
    participantIds: Array.from(call.participantIds),
    isGroup: call.isGroup,
    callType: call.callType,
    answeredAt: call.answeredAt?.toISOString(),
  };
  return JSON.stringify(payload);
}

function deserialize(raw: string | null): ActiveCall | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as SerializedCall;
    return {
      callId: p.callId,
      conversationId: p.conversationId,
      initiatorId: p.initiatorId,
      participantIds: new Set(p.participantIds),
      isGroup: p.isGroup,
      callType: p.callType,
      answeredAt: p.answeredAt ? new Date(p.answeredAt) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to deserialize call state');
    return undefined;
  }
}

class RedisCallStateStore implements CallStateStore {
  // Timer handles are runtime objects — can't be shared across Node processes.
  // Each instance tracks the timers it owns; cross-instance coordination
  // happens inside the timer callback by re-reading Redis + socket.io adapter.
  private readonly unansweredTimers = new Map<string, NodeJS.Timeout>();
  private readonly disconnectTimers = new Map<string, { timeout: NodeJS.Timeout; callId: string }>();

  constructor(private readonly redis: Redis) {}

  async isUserInCall(userId: string): Promise<boolean> {
    const result = await this.redis.exists(userCallKey(userId));
    return result === 1;
  }

  async getCall(callId: string): Promise<ActiveCall | undefined> {
    const raw = await this.redis.get(callKey(callId));
    return deserialize(raw);
  }

  async getUserCallId(userId: string): Promise<string | undefined> {
    const value = await this.redis.get(userCallKey(userId));
    return value ?? undefined;
  }

  async addCall(call: ActiveCall): Promise<void> {
    await this.redis.set(callKey(call.callId), serialize(call), 'EX', CALL_KEY_TTL_SECONDS);
  }

  async mapUserToCall(userId: string, callId: string): Promise<void> {
    await this.redis.set(userCallKey(userId), callId, 'EX', CALL_KEY_TTL_SECONDS);
  }

  async unmapUser(userId: string): Promise<void> {
    await this.redis.del(userCallKey(userId));
  }

  async markAnswered(callId: string, userId: string, answeredAt: Date): Promise<boolean> {
    // Atomic first-answer lock: SET NX succeeds only for the first caller.
    const locked = await this.redis.set(answeredLockKey(callId), userId, 'EX', CALL_KEY_TTL_SECONDS, 'NX');
    if (locked !== 'OK') return false;

    // Update the call JSON. Read-modify-write — safe because the lock above
    // guarantees this is the only path setting answeredAt.
    const raw = await this.redis.get(callKey(callId));
    const call = deserialize(raw);
    if (!call) {
      // Call vanished between lock and read (TTL expired). Release the lock.
      await this.redis.del(answeredLockKey(callId));
      return false;
    }
    call.answeredAt = answeredAt;
    await this.redis.set(callKey(call.callId), serialize(call), 'EX', CALL_KEY_TTL_SECONDS);
    return true;
  }

  async claimTermination(callId: string): Promise<boolean> {
    // Atomic first-terminator lock: SET NX succeeds only for the first caller.
    // The short TTL is a failsafe — cleanup() drops this key in its pipeline.
    const locked = await this.redis.set(
      terminatingLockKey(callId),
      '1',
      'EX',
      TERMINATING_LOCK_TTL_SECONDS,
      'NX',
    );
    return locked === 'OK';
  }

  async cleanup(callId: string): Promise<void> {
    const call = await this.getCall(callId);
    this.clearUnansweredTimer(callId);
    if (!call) {
      // Best-effort: call entry already gone, but still nuke any user map rows
      // we might still have (caller might pass callId from a stale in-memory ref).
      // Leave terminatingLockKey intact — it self-expires and guards against
      // racing teardown paths claiming termination after the call is gone.
      await this.redis.del(callKey(callId), answeredLockKey(callId));
      return;
    }
    const pipeline = this.redis.pipeline();
    pipeline.del(callKey(callId));
    pipeline.del(answeredLockKey(callId));
    // Intentionally leave terminatingLockKey intact — it self-expires via
    // its short TTL. Keeping it lets a delayed "end" arriving after cleanup
    // (e.g. timeout callback racing an explicit end across instances) fail
    // the claim instead of re-running side effects against a stale snapshot.
    for (const pid of call.participantIds) {
      pipeline.del(userCallKey(pid));
      pipeline.del(pushEnqueuedKey(callId, pid));
      pipeline.del(ringingAckedKey(callId, pid));
    }
    await pipeline.exec();
  }

  async markPushEnqueued(callId: string, userId: string, at: number): Promise<void> {
    await this.redis.set(pushEnqueuedKey(callId, userId), String(at), 'EX', PUSH_TRACKING_TTL_SECONDS);
  }

  async markRinging(callId: string, userId: string): Promise<void> {
    await this.redis.set(ringingAckedKey(callId, userId), '1', 'EX', PUSH_TRACKING_TTL_SECONDS);
  }

  async hasRingingAcked(callId: string, userId: string): Promise<boolean> {
    const v = await this.redis.get(ringingAckedKey(callId, userId));
    return v === '1';
  }

  async shouldSuppressCancelPush(
    callId: string,
    userId: string,
    windowMs: number,
  ): Promise<boolean> {
    // One round-trip via pipeline so we don't pay 2× latency in the hot
    // call:end path.
    const [ackedRes, atRes] = await this.redis
      .pipeline()
      .get(ringingAckedKey(callId, userId))
      .get(pushEnqueuedKey(callId, userId))
      .exec() ?? [];
    const acked = ackedRes?.[1];
    const atRaw = atRes?.[1];
    if (acked) return false;
    if (typeof atRaw !== 'string') return false;
    const at = Number(atRaw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < windowMs;
  }

  async removeParticipant(callId: string, userId: string): Promise<void> {
    const call = await this.getCall(callId);
    if (call) {
      call.participantIds.delete(userId);
      await this.redis.set(callKey(callId), serialize(call), 'EX', CALL_KEY_TTL_SECONDS);
    }
    await this.redis.del(userCallKey(userId));
  }

  setUnansweredTimer(callId: string, handle: NodeJS.Timeout): void {
    const existing = this.unansweredTimers.get(callId);
    if (existing) clearTimeout(existing);
    this.unansweredTimers.set(callId, handle);
  }

  clearUnansweredTimer(callId: string): void {
    const existing = this.unansweredTimers.get(callId);
    if (existing) {
      clearTimeout(existing);
      this.unansweredTimers.delete(callId);
    }
  }

  setDisconnectGrace(userId: string, handle: NodeJS.Timeout, callId: string): void {
    const existing = this.disconnectTimers.get(userId);
    if (existing) clearTimeout(existing.timeout);
    this.disconnectTimers.set(userId, { timeout: handle, callId });
  }

  takeDisconnectGrace(userId: string): { callId: string } | undefined {
    const existing = this.disconnectTimers.get(userId);
    if (!existing) return undefined;
    clearTimeout(existing.timeout);
    this.disconnectTimers.delete(userId);
    return { callId: existing.callId };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

let storeInstance: CallStateStore | null = null;

/**
 * Returns the call state store appropriate for the current deployment.
 * Falls back to in-memory if Redis isn't configured or fails to initialise
 * so local dev keeps working without ceremony.
 */
export function getCallStateStore(): CallStateStore {
  if (storeInstance) return storeInstance;
  const redis = getRedis();
  if (redis) {
    logger.info('Using Redis-backed call state store (horizontal scale enabled)');
    storeInstance = new RedisCallStateStore(redis);
  } else {
    logger.info('Using in-memory call state store (single-instance mode)');
    storeInstance = new InMemoryCallStateStore();
  }
  return storeInstance;
}
