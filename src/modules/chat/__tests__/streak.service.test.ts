import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma: any = {
    messageStreak: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  recordMessageForStreak,
  getStreak,
  tryRecordMessageForStreak,
} from '../streak.service';

beforeEach(() => {
  vi.clearAllMocks();
});

function utcDayN(daysAgo = 0): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

// ─── recordMessageForStreak ──────────────────────────────────────────

describe('recordMessageForStreak', () => {
  it('no-op for self-DM', async () => {
    await recordMessageForStreak('user-1', 'user-1');
    expect(mockPrisma.messageStreak.upsert).not.toHaveBeenCalled();
  });

  it('only sender messaged today: writes lastUserAMessageDay but no mutual update', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue(null);

    // 'a' < 'b' so canonical pair: userAId='a', userBId='b', sender='a' is A
    await recordMessageForStreak('a', 'b');

    const args = (mockPrisma.messageStreak.upsert.mock.calls[0][0] as any);
    expect(args.create.lastUserAMessageDay).toBeInstanceOf(Date);
    // No mutual since other side hasn't messaged today
    expect(args.create.lastMutualDay).toBeNull();
    expect(args.create.count).toBe(0);
  });

  it('both messaged today AND first time: count=1 mutual=today', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 0,
      lastMutualDay: null,
      lastUserAMessageDay: null,
      lastUserBMessageDay: utcDayN(0),  // B already messaged today
    });

    await recordMessageForStreak('a', 'b');

    const args = (mockPrisma.messageStreak.upsert.mock.calls[0][0] as any);
    expect(args.update.count).toBe(1);
    expect(args.update.lastMutualDay).toBeInstanceOf(Date);
  });

  it('both messaged today, lastMutual=yesterday: increments count', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 5,
      lastMutualDay: utcDayN(1),
      lastUserAMessageDay: null,
      lastUserBMessageDay: utcDayN(0),
    });

    await recordMessageForStreak('a', 'b');

    const args = (mockPrisma.messageStreak.upsert.mock.calls[0][0] as any);
    expect(args.update.count).toBe(6);
  });

  it('both messaged today, lastMutual=today already: no count change', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 7,
      lastMutualDay: utcDayN(0),
      lastUserAMessageDay: null,
      lastUserBMessageDay: utcDayN(0),
    });

    await recordMessageForStreak('a', 'b');

    const args = (mockPrisma.messageStreak.upsert.mock.calls[0][0] as any);
    expect(args.update.count).toBe(7);
  });

  it('both messaged today, lastMutual is older than yesterday: resets to 1', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 100,
      lastMutualDay: utcDayN(5),
      lastUserAMessageDay: null,
      lastUserBMessageDay: utcDayN(0),
    });

    await recordMessageForStreak('a', 'b');

    const args = (mockPrisma.messageStreak.upsert.mock.calls[0][0] as any);
    expect(args.update.count).toBe(1);
  });

  it('canonicalizes pair so order does not matter', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue(null);

    await recordMessageForStreak('z', 'a');

    const args = (mockPrisma.messageStreak.findUnique.mock.calls[0][0] as any);
    expect(args.where.userAId_userBId).toEqual({ userAId: 'a', userBId: 'z' });
  });
});

// ─── getStreak ────────────────────────────────────────────────────────

describe('getStreak', () => {
  it('returns inactive zero for self', async () => {
    expect(await getStreak('a', 'a')).toEqual({ count: 0, isActive: false });
  });

  it('returns inactive zero when no row', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue(null);

    expect(await getStreak('a', 'b')).toEqual({ count: 0, isActive: false });
  });

  it('returns inactive zero when lastMutualDay is null', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 5, lastMutualDay: null,
    });

    expect(await getStreak('a', 'b')).toEqual({ count: 0, isActive: false });
  });

  it('isActive=true when mutual today (diff=0)', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 7, lastMutualDay: utcDayN(0),
    });

    expect(await getStreak('a', 'b')).toEqual({ count: 7, isActive: true });
  });

  it('isActive=true when mutual yesterday (diff=1)', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 7, lastMutualDay: utcDayN(1),
    });

    expect(await getStreak('a', 'b')).toEqual({ count: 7, isActive: true });
  });

  it('isActive=false when mutual older than yesterday (diff>=2)', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue({
      count: 7, lastMutualDay: utcDayN(3),
    });

    expect(await getStreak('a', 'b')).toEqual({ count: 7, isActive: false });
  });
});

// ─── tryRecordMessageForStreak ───────────────────────────────────────

describe('tryRecordMessageForStreak', () => {
  it('swallows errors silently', async () => {
    mockPrisma.messageStreak.findUnique.mockRejectedValue(new Error('db down'));

    await expect(tryRecordMessageForStreak('a', 'b')).resolves.toBeUndefined();
  });

  it('forwards on success', async () => {
    mockPrisma.messageStreak.findUnique.mockResolvedValue(null);

    await tryRecordMessageForStreak('a', 'b');

    expect(mockPrisma.messageStreak.upsert).toHaveBeenCalled();
  });
});
