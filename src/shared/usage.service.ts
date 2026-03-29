import { prisma } from '../config/database';
import { logger } from './logger';
import * as redis from './redis.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const FREE_CALL_MINS = 5;
const FREE_KORA_SESSIONS = 2;
const FREE_KORA_MESSAGES = 3;
const FREE_TRANSCRIPTIONS = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Today's date string in YYYY-MM-DD (UTC). */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Midnight UTC of the *next* day — when daily limits reset. */
function nextMidnightUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Seconds remaining until the next UTC midnight. */
function secondsUntilMidnight(): number {
  return Math.ceil((nextMidnightUTC().getTime() - Date.now()) / 1000);
}

// ─── Limits ──────────────────────────────────────────────────────────────────

export const LIMITS = {
  FREE: { bioLength: 200, storyUploadMB: 50, pinnedChats: 3 },
  PRO:  { bioLength: 500, storyUploadMB: 100, pinnedChats: 10 },
} as const;

export async function getLimits(userId: string) {
  return (await isPro(userId)) ? LIMITS.PRO : LIMITS.FREE;
}

// ─── Pro Check ───────────────────────────────────────────────────────────────

/** Check whether a user is Pro (verified OR has active subscription). */
export async function isPro(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        isVerified: true,
        subscription: { select: { status: true } },
      },
    });
    if (!user) return false;
    if (user.isVerified) return true;
    // Check for active RevenueCat subscription
    const subStatus = user.subscription?.status;
    return subStatus === 'active' || subStatus === 'trialing';
  } catch (err) {
    logger.error({ err, userId }, 'Failed to check Pro status');
    return false;
  }
}

// ─── Call Minutes ─────────────────────────────────────────────────────────────

export interface CallMinutesResult {
  allowed: boolean;
  usedMins: number;
  limitMins: number;
  resetAt: string;
}

/**
 * Check how many call minutes a user has consumed today.
 * Pro users always get `allowed: true` with `limitMins: -1`.
 */
export async function checkCallMinutes(userId: string): Promise<CallMinutesResult> {
  const resetAt = nextMidnightUTC().toISOString();

  if (await isPro(userId)) {
    return { allowed: true, usedMins: 0, limitMins: -1, resetAt };
  }

  const key = `usage:calls:${userId}:${todayKey()}`;

  try {
    const raw = await redis.get(key);
    const usedSecs = raw ? parseInt(raw as string, 10) : 0;
    const usedMins = Math.ceil(usedSecs / 60);

    return {
      allowed: usedMins < FREE_CALL_MINS,
      usedMins,
      limitMins: FREE_CALL_MINS,
      resetAt,
    };
  } catch (err) {
    logger.error({ err, userId }, 'checkCallMinutes failed — allowing');
    return { allowed: true, usedMins: 0, limitMins: FREE_CALL_MINS, resetAt };
  }
}

/**
 * Record call seconds consumed by a user.
 */
export async function addCallMinutes(userId: string, seconds: number): Promise<void> {
  if (await isPro(userId)) return;
  if (seconds <= 0) return;

  const key = `usage:calls:${userId}:${todayKey()}`;

  try {
    const client = redis.getRedis();
    if (!client) return;

    // INCRBY is atomic; if key doesn't exist yet Redis creates it at 0 first.
    await client.incrby(key, Math.round(seconds));
    await redis.expire(key, secondsUntilMidnight());
  } catch (err) {
    logger.error({ err, userId, seconds }, 'addCallMinutes failed');
  }
}

// ─── Voice Transcriptions ─────────────────────────────────────────────────────

export interface TranscriptionResult {
  allowed: boolean;
  used: number;
  limit: number;
  resetAt: string;
}

export async function checkTranscription(userId: string): Promise<TranscriptionResult> {
  const resetAt = nextMidnightUTC().toISOString();
  if (await isPro(userId)) {
    return { allowed: true, used: 0, limit: -1, resetAt };
  }
  const key = `usage:transcriptions:${userId}:${todayKey()}`;
  try {
    const raw = await redis.get(key);
    const used = raw ? parseInt(raw as string, 10) : 0;
    return { allowed: used < FREE_TRANSCRIPTIONS, used, limit: FREE_TRANSCRIPTIONS, resetAt };
  } catch (err) {
    logger.error({ err, userId }, 'checkTranscription failed — allowing');
    return { allowed: true, used: 0, limit: FREE_TRANSCRIPTIONS, resetAt };
  }
}

export async function incrementTranscription(userId: string): Promise<void> {
  if (await isPro(userId)) return;
  const key = `usage:transcriptions:${userId}:${todayKey()}`;
  try {
    await redis.incr(key);
    await redis.expire(key, secondsUntilMidnight());
  } catch (err) {
    logger.error({ err, userId }, 'incrementTranscription failed');
  }
}

// ─── Kora Sessions ────────────────────────────────────────────────────────────

export interface KoraSessionResult {
  allowed: boolean;
  sessionsUsed: number;
  limitSessions: number;
  resetAt: string;
}

/**
 * Check how many Kora sessions a user has started today.
 */
export async function checkKoraSession(userId: string): Promise<KoraSessionResult> {
  const resetAt = nextMidnightUTC().toISOString();

  if (await isPro(userId)) {
    return { allowed: true, sessionsUsed: 0, limitSessions: -1, resetAt };
  }

  const key = `usage:kora_sessions:${userId}:${todayKey()}`;

  try {
    const raw = await redis.get(key);
    const sessionsUsed = raw ? parseInt(raw as string, 10) : 0;

    return {
      allowed: sessionsUsed < FREE_KORA_SESSIONS,
      sessionsUsed,
      limitSessions: FREE_KORA_SESSIONS,
      resetAt,
    };
  } catch (err) {
    logger.error({ err, userId }, 'checkKoraSession failed — allowing');
    return { allowed: true, sessionsUsed: 0, limitSessions: FREE_KORA_SESSIONS, resetAt };
  }
}

/**
 * Increment the Kora session counter for today.
 */
export async function incrementKoraSession(userId: string): Promise<void> {
  if (await isPro(userId)) return;

  const key = `usage:kora_sessions:${userId}:${todayKey()}`;

  try {
    await redis.incr(key);
    await redis.expire(key, secondsUntilMidnight());
  } catch (err) {
    logger.error({ err, userId }, 'incrementKoraSession failed');
  }
}

// ─── Kora Messages ────────────────────────────────────────────────────────────

export interface KoraMessageResult {
  allowed: boolean;
  messagesUsed: number;
  limitMessages: number;
}

/**
 * Check how many messages a user has sent in a specific Kora session.
 */
export async function checkKoraMessages(userId: string, sessionId: string): Promise<KoraMessageResult> {
  if (await isPro(userId)) {
    return { allowed: true, messagesUsed: 0, limitMessages: -1 };
  }

  const key = `usage:kora_msgs:${userId}:${sessionId}`;

  try {
    const raw = await redis.get(key);
    const messagesUsed = raw ? parseInt(raw as string, 10) : 0;

    return {
      allowed: messagesUsed < FREE_KORA_MESSAGES,
      messagesUsed,
      limitMessages: FREE_KORA_MESSAGES,
    };
  } catch (err) {
    logger.error({ err, userId, sessionId }, 'checkKoraMessages failed — allowing');
    return { allowed: true, messagesUsed: 0, limitMessages: FREE_KORA_MESSAGES };
  }
}

/**
 * Increment the message counter for a Kora session.
 */
export async function incrementKoraMessage(userId: string, sessionId: string): Promise<void> {
  if (await isPro(userId)) return;

  const key = `usage:kora_msgs:${userId}:${sessionId}`;

  try {
    await redis.incr(key);
    // Session messages don't need daily TTL — session TTL is sufficient (24h)
    await redis.expire(key, 86400);
  } catch (err) {
    logger.error({ err, userId, sessionId }, 'incrementKoraMessage failed');
  }
}

// ─── Aggregated Usage (for /users/me/usage endpoint) ──────────────────────────

export interface UsageSummary {
  isPro: boolean;
  calls: { usedMins: number; limitMins: number; resetAt: string };
  kora: {
    sessionsUsed: number;
    limitSessions: number;
    messagesUsed: number;
    limitMessages: number;
    resetAt: string;
  };
  transcription: { used: number; limit: number; resetAt: string };
  limits: { bioLength: number; storyUploadMB: number; pinnedChats: number };
}

/**
 * Return the full usage summary for a user.
 * Used by GET /users/me/usage.
 */
export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const pro = await isPro(userId);
  const resetAt = nextMidnightUTC().toISOString();

  const limits = pro ? LIMITS.PRO : LIMITS.FREE;

  if (pro) {
    return {
      isPro: true,
      calls: { usedMins: 0, limitMins: -1, resetAt },
      kora: {
        sessionsUsed: 0,
        limitSessions: -1,
        messagesUsed: 0,
        limitMessages: -1,
        resetAt,
      },
      transcription: { used: 0, limit: -1, resetAt },
      limits,
    };
  }

  const [callResult, sessionResult, txResult] = await Promise.all([
    checkCallMinutes(userId),
    checkKoraSession(userId),
    checkTranscription(userId),
  ]);

  return {
    isPro: false,
    calls: {
      usedMins: callResult.usedMins,
      limitMins: callResult.limitMins,
      resetAt,
    },
    kora: {
      sessionsUsed: sessionResult.sessionsUsed,
      limitSessions: sessionResult.limitSessions,
      messagesUsed: 0, // per-session, shown via checkKoraMessages
      limitMessages: FREE_KORA_MESSAGES,
      resetAt,
    },
    transcription: { used: txResult.used, limit: txResult.limit, resetAt },
    limits,
  };
}
