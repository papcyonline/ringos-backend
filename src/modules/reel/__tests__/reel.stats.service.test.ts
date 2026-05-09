import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    reel: { findUnique: vi.fn() },
    reelView: { aggregate: vi.fn(), count: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));

import { getReelStats } from '../reel.stats.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reel.stats.service', () => {
  it('throws when reel not found', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue(null);
    await expect(getReelStats('r-1', 'u-1')).rejects.toThrow(/not found/i);
  });

  it('throws when not owner', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({ id: 'r-1', userId: 'other' });
    await expect(getReelStats('r-1', 'u-1')).rejects.toThrow(/private/);
  });

  it('returns aggregated stats with 7 days padded', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({
      id: 'r-1', userId: 'u-1', createdAt: new Date(),
      viewCount: 100, likeCount: 10, commentCount: 5, repostCount: 5,
    });
    mockPrisma.reelView.aggregate.mockResolvedValue({
      _avg: { watchedSec: 12.345 },
      _count: { id: 100 },
    });
    mockPrisma.reelView.count
      .mockResolvedValueOnce(50) // completedCount
      .mockResolvedValueOnce(80); // uniqueViewers
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const res = await getReelStats('r-1', 'u-1');

    expect(res.reelId).toBe('r-1');
    expect(res.totals.views).toBe(100);
    expect(res.totals.uniqueViewers).toBe(80);
    expect(res.watch.completedCount).toBe(50);
    expect(res.watch.completionRate).toBe(0.5);
    expect(res.engagementRate).toBe(0.2); // (10+5+5)/100
    expect(res.viewsPerDay).toHaveLength(7);
    expect(res.viewsPerDay.every((d) => d.count === 0)).toBe(true);
  });

  it('handles zero views safely (no division by zero)', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({
      id: 'r-1', userId: 'u-1', createdAt: new Date(),
      viewCount: 0, likeCount: 0, commentCount: 0, repostCount: 0,
    });
    mockPrisma.reelView.aggregate.mockResolvedValue({
      _avg: { watchedSec: null },
      _count: { id: 0 },
    });
    mockPrisma.reelView.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const res = await getReelStats('r-1', 'u-1');
    expect(res.engagementRate).toBe(0);
    expect(res.watch.completionRate).toBe(0);
    expect(res.watch.avgWatchedSec).toBe(0);
  });

  it('fills in actual day counts from query', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({
      id: 'r-1', userId: 'u-1', createdAt: new Date(),
      viewCount: 10, likeCount: 0, commentCount: 0, repostCount: 0,
    });
    mockPrisma.reelView.aggregate.mockResolvedValue({
      _avg: { watchedSec: 5 },
      _count: { id: 10 },
    });
    mockPrisma.reelView.count.mockResolvedValue(0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    mockPrisma.$queryRaw.mockResolvedValue([
      { date: today, count: BigInt(7) },
    ]);

    const res = await getReelStats('r-1', 'u-1');
    const todayKey = today.toISOString().slice(0, 10);
    const found = res.viewsPerDay.find((d) => d.date === todayKey);
    expect(found?.count).toBe(7);
  });
});
