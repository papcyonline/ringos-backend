import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockRedis, mockRedisClient } = vi.hoisted(() => {
  const mockRedisClient = { incrby: vi.fn() };
  const mockRedis: any = {
    get: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    getRedis: vi.fn(() => mockRedisClient),
  };
  const mockPrisma: any = {
    user: { findUnique: vi.fn() },
  };
  return { mockPrisma, mockRedis, mockRedisClient };
});

vi.mock('../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../redis.service', () => mockRedis);
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isPro,
  getLimits,
  LIMITS,
  checkCallMinutes,
  addCallMinutes,
  checkTranscription,
  incrementTranscription,
  checkKoraSession,
  incrementKoraSession,
  checkKoraMessages,
  incrementKoraMessage,
  getUsageSummary,
} from '../usage.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.getRedis.mockImplementation(() => mockRedisClient);
});

// ─── isPro ───────────────────────────────────────────────────────────

describe('isPro', () => {
  it('returns true for verified user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true, subscription: null });
    expect(await isPro('user-1')).toBe(true);
  });

  it('returns true for active subscription', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: { status: 'active' } });
    expect(await isPro('user-1')).toBe(true);
  });

  it('returns true for trialing subscription', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: { status: 'trialing' } });
    expect(await isPro('user-1')).toBe(true);
  });

  it('returns false for free user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    expect(await isPro('user-1')).toBe(false);
  });

  it('returns false for missing user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    expect(await isPro('ghost')).toBe(false);
  });

  it('returns false for cancelled subscription', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: { status: 'cancelled' } });
    expect(await isPro('user-1')).toBe(false);
  });

  it('swallows errors and returns false', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('db down'));
    expect(await isPro('user-1')).toBe(false);
  });
});

// ─── getLimits ───────────────────────────────────────────────────────

describe('getLimits', () => {
  it('returns FREE limits for free user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    expect(await getLimits('user-1')).toEqual(LIMITS.FREE);
  });

  it('returns PRO limits for verified user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true, subscription: null });
    expect(await getLimits('user-1')).toEqual(LIMITS.PRO);
  });
});

// ─── checkCallMinutes ────────────────────────────────────────────────

describe('checkCallMinutes', () => {
  it('Pro users always allowed with limitMins=-1', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });

    const res = await checkCallMinutes('user-1');

    expect(res).toMatchObject({ allowed: true, usedMins: 0, limitMins: -1 });
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('free user under limit: allowed=true', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('120'); // 2 minutes used

    const res = await checkCallMinutes('user-1');

    expect(res.allowed).toBe(true);
    expect(res.usedMins).toBe(2);
    expect(res.limitMins).toBe(5);
  });

  it('free user at limit: allowed=false', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('300'); // 5 minutes used

    const res = await checkCallMinutes('user-1');

    expect(res.allowed).toBe(false);
    expect(res.usedMins).toBe(5);
  });

  it('redis failure fails open (allowed=true)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockRejectedValue(new Error('redis down'));

    const res = await checkCallMinutes('user-1');

    expect(res.allowed).toBe(true);
    expect(res.usedMins).toBe(0);
  });

  it('treats null redis value as 0 used', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue(null);

    const res = await checkCallMinutes('user-1');

    expect(res.usedMins).toBe(0);
    expect(res.allowed).toBe(true);
  });
});

// ─── addCallMinutes ──────────────────────────────────────────────────

describe('addCallMinutes', () => {
  it('Pro users do not consume quota', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });

    await addCallMinutes('user-1', 30);

    expect(mockRedisClient.incrby).not.toHaveBeenCalled();
  });

  it('skips when seconds <= 0', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });

    await addCallMinutes('user-1', 0);

    expect(mockRedisClient.incrby).not.toHaveBeenCalled();
  });

  it('atomically increments and sets TTL for free users', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });

    await addCallMinutes('user-1', 45);

    expect(mockRedisClient.incrby).toHaveBeenCalledWith(expect.stringContaining('usage:calls:user-1:'), 45);
    expect(mockRedis.expire).toHaveBeenCalled();
  });

  it('rounds float seconds before incrementing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });

    await addCallMinutes('user-1', 12.7);

    expect(mockRedisClient.incrby).toHaveBeenCalledWith(expect.any(String), 13);
  });

  it('skips silently when redis client is unavailable', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.getRedis.mockReturnValueOnce(null);

    await addCallMinutes('user-1', 30);

    expect(mockRedisClient.incrby).not.toHaveBeenCalled();
  });
});

// ─── checkTranscription / incrementTranscription ─────────────────────

describe('checkTranscription', () => {
  it('Pro users always allowed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });

    const res = await checkTranscription('user-1');

    expect(res).toMatchObject({ allowed: true, used: 0, limit: -1 });
  });

  it('free user under limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('1');

    const res = await checkTranscription('user-1');

    expect(res).toMatchObject({ allowed: true, used: 1, limit: 3 });
  });

  it('free user at limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('3');

    const res = await checkTranscription('user-1');

    expect(res.allowed).toBe(false);
  });

  it('redis failure fails open', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockRejectedValue(new Error('redis down'));

    const res = await checkTranscription('user-1');

    expect(res.allowed).toBe(true);
  });
});

describe('incrementTranscription', () => {
  it('Pro users skip incr', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    await incrementTranscription('user-1');
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('free user incr + sets TTL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });

    await incrementTranscription('user-1');

    expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('usage:transcriptions:user-1:'));
    expect(mockRedis.expire).toHaveBeenCalled();
  });
});

// ─── Kora session quotas ─────────────────────────────────────────────

describe('checkKoraSession', () => {
  it('Pro: unlimited', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    const res = await checkKoraSession('user-1');
    expect(res.limitSessions).toBe(-1);
  });

  it('free user under limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('1');

    const res = await checkKoraSession('user-1');

    expect(res).toMatchObject({ allowed: true, sessionsUsed: 1, limitSessions: 2 });
  });

  it('free user at limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('2');

    const res = await checkKoraSession('user-1');

    expect(res.allowed).toBe(false);
  });
});

describe('incrementKoraSession', () => {
  it('Pro: skip', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    await incrementKoraSession('user-1');
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('free user: incr + TTL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    await incrementKoraSession('user-1');
    expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('usage:kora_sessions:'));
  });
});

// ─── Kora message quotas ─────────────────────────────────────────────

describe('checkKoraMessages', () => {
  it('Pro: unlimited', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    const res = await checkKoraMessages('user-1', 'sess-1');
    expect(res.limitMessages).toBe(-1);
  });

  it('free user under limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('2');

    const res = await checkKoraMessages('user-1', 'sess-1');

    expect(res).toMatchObject({ allowed: true, messagesUsed: 2, limitMessages: 3 });
  });

  it('free user at limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    mockRedis.get.mockResolvedValue('3');

    const res = await checkKoraMessages('user-1', 'sess-1');

    expect(res.allowed).toBe(false);
  });
});

describe('incrementKoraMessage', () => {
  it('Pro: skip', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });
    await incrementKoraMessage('user-1', 'sess-1');
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('free user: incr + 24h TTL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    await incrementKoraMessage('user-1', 'sess-1');

    expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('usage:kora_msgs:user-1:sess-1'));
    expect(mockRedis.expire).toHaveBeenCalledWith(expect.any(String), 86400);
  });
});

// ─── getUsageSummary ─────────────────────────────────────────────────

describe('getUsageSummary', () => {
  it('Pro user: all limits = -1, calls aggregator skipped', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: true });

    const res = await getUsageSummary('user-1');

    expect(res.isPro).toBe(true);
    expect(res.calls.limitMins).toBe(-1);
    expect(res.kora.limitSessions).toBe(-1);
    expect(res.kora.limitMessages).toBe(-1);
    expect(res.transcription.limit).toBe(-1);
    expect(res.limits).toEqual(LIMITS.PRO);
    // No redis calls for Pro path
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('free user: aggregates call/session/transcription state from redis', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isVerified: false, subscription: null });
    // checkCallMinutes, checkKoraSession, checkTranscription each call isPro
    // (which findUnique resolves) plus redis.get
    mockRedis.get
      .mockResolvedValueOnce('60')   // calls (1 min)
      .mockResolvedValueOnce('1')    // kora sessions
      .mockResolvedValueOnce('2');   // transcriptions

    const res = await getUsageSummary('user-1');

    expect(res.isPro).toBe(false);
    expect(res.calls.usedMins).toBe(1);
    expect(res.calls.limitMins).toBe(5);
    expect(res.kora.sessionsUsed).toBe(1);
    expect(res.kora.limitSessions).toBe(2);
    expect(res.transcription.used).toBe(2);
    expect(res.transcription.limit).toBe(3);
    expect(res.limits).toEqual(LIMITS.FREE);
  });
});
