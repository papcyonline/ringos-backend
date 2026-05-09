import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma: any = {
    coinBalance: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    coinTransaction: {
      create: vi.fn(),
    },
    storyGift: {
      create: vi.fn(),
      groupBy: vi.fn(),
    },
    story: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../notification/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(null),
  sendPostPush: vi.fn().mockResolvedValue(null),
}));

import {
  getBalance,
  purchaseCoins,
  sendGift,
  getStoryGiftStats,
  GIFT_TYPES,
} from '../coins.service';
import { BadRequestError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
});

// ─── getBalance ──────────────────────────────────────────────────────

describe('getBalance', () => {
  it('returns 0 when no balance row exists', async () => {
    mockPrisma.coinBalance.findUnique.mockResolvedValue(null);
    expect(await getBalance('user-1')).toBe(0);
  });

  it('returns the stored balance when row exists', async () => {
    mockPrisma.coinBalance.findUnique.mockResolvedValue({ balance: 750 });
    expect(await getBalance('user-1')).toBe(750);
  });
});

// ─── purchaseCoins ───────────────────────────────────────────────────

describe('purchaseCoins', () => {
  it('rejects unknown pack id', async () => {
    await expect(purchaseCoins('user-1', 'coins_999')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('credits 100 coins for coins_100 pack', async () => {
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.update.mockResolvedValue({ balance: 100 });
    mockPrisma.coinTransaction.create.mockResolvedValue({ id: 'tx-1' });

    const res = await purchaseCoins('user-1', 'coins_100');

    expect(res.balance).toBe(100);
    expect(mockPrisma.coinBalance.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      data: { balance: { increment: 100 } },
    }));
    expect(mockPrisma.coinTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 100, type: 'PURCHASE' }),
    }));
  });

  it('credits 1200 coins for coins_1200 pack', async () => {
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.update.mockResolvedValue({ balance: 1200 });
    mockPrisma.coinTransaction.create.mockResolvedValue({ id: 'tx-1' });

    await purchaseCoins('user-1', 'coins_1200');

    expect(mockPrisma.coinBalance.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { balance: { increment: 1200 } },
    }));
  });

  it('ensures balance row exists before incrementing', async () => {
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.update.mockResolvedValue({ balance: 500 });
    mockPrisma.coinTransaction.create.mockResolvedValue({});

    await purchaseCoins('user-1', 'coins_500');

    expect(mockPrisma.coinBalance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', balance: 0 },
    }));
  });
});

// ─── sendGift ────────────────────────────────────────────────────────

describe('sendGift', () => {
  it('rejects unknown gift type', async () => {
    await expect(sendGift('user-1', 'story-1', 'unicorn')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws NotFoundError when story missing', async () => {
    mockPrisma.story.findUnique.mockResolvedValue(null);
    await expect(sendGift('user-1', 'story-x', 'heart')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects gifting your own story', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 'story-1', userId: 'user-1' });

    await expect(sendGift('user-1', 'story-1', 'heart')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects insufficient balance', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 'story-1', userId: 'recipient-1' });
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.findUnique.mockResolvedValue({ balance: 2 });  // < 5 (heart)

    await expect(sendGift('user-1', 'story-1', 'heart')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('debits sender, credits recipient, records gift on success', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 'story-1', userId: 'recipient-1' });
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.findUnique.mockResolvedValue({ balance: 100 });
    mockPrisma.coinBalance.update
      .mockResolvedValueOnce({ balance: 75 })  // sender after debit
      .mockResolvedValueOnce({ balance: 25 }); // recipient after credit
    mockPrisma.coinTransaction.create.mockResolvedValue({});
    mockPrisma.storyGift.create.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: null });

    const res = await sendGift('user-1', 'story-1', 'star');

    expect(res).toMatchObject({
      success: true,
      giftType: 'star',
      coinAmount: 25,
      newBalance: 75,
    });

    // Sender debit
    expect(mockPrisma.coinBalance.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      data: { balance: { decrement: 25 } },
    }));
    // Recipient credit
    expect(mockPrisma.coinBalance.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'recipient-1' },
      data: { balance: { increment: 25 } },
    }));
    // GIFT row + TIP row + StoryGift row
    expect(mockPrisma.coinTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'GIFT', amount: -25 }),
    }));
    expect(mockPrisma.coinTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'TIP', amount: 25 }),
    }));
    expect(mockPrisma.storyGift.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        senderId: 'user-1',
        recipientId: 'recipient-1',
        giftType: 'star',
        coinAmount: 25,
      }),
    }));
  });

  it('fires push notification when sender exists', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 'story-1', userId: 'recipient-1' });
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.findUnique.mockResolvedValue({ balance: 1000 });
    mockPrisma.coinBalance.update
      .mockResolvedValueOnce({ balance: 500 })
      .mockResolvedValueOnce({ balance: 500 });
    mockPrisma.coinTransaction.create.mockResolvedValue({});
    mockPrisma.storyGift.create.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice', avatarUrl: 'a.jpg' });

    await sendGift('user-1', 'story-1', 'crown');

    const notif = await import('../../notification/notification.service');
    expect(notif.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'recipient-1',
      type: 'STORY_GIFT',
      title: 'Alice',
    }));
    expect(notif.sendPostPush).toHaveBeenCalledWith('recipient-1', expect.objectContaining({
      title: 'Alice',
      data: expect.objectContaining({ giftType: 'crown', coinAmount: '500' }),
    }));
  });

  it('skips notifications when sender record missing', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 'story-1', userId: 'recipient-1' });
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.findUnique.mockResolvedValue({ balance: 100 });
    mockPrisma.coinBalance.update
      .mockResolvedValueOnce({ balance: 95 })
      .mockResolvedValueOnce({ balance: 5 });
    mockPrisma.coinTransaction.create.mockResolvedValue({});
    mockPrisma.storyGift.create.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await sendGift('user-1', 'story-1', 'heart');

    const notif = await import('../../notification/notification.service');
    expect(notif.createNotification).not.toHaveBeenCalled();
    expect(notif.sendPostPush).not.toHaveBeenCalled();
  });

  it.each(Object.entries(GIFT_TYPES))('gift %s costs %d coins', async (giftType, expectedCost) => {
    mockPrisma.story.findUnique.mockResolvedValue({ id: 'story-1', userId: 'recipient-1' });
    mockPrisma.coinBalance.upsert.mockResolvedValue({});
    mockPrisma.coinBalance.findUnique.mockResolvedValue({ balance: 10000 });
    mockPrisma.coinBalance.update.mockResolvedValue({ balance: 9000 });
    mockPrisma.coinTransaction.create.mockResolvedValue({});
    mockPrisma.storyGift.create.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await sendGift('user-1', 'story-1', giftType);

    expect(res.coinAmount).toBe(expectedCost);
  });
});

// ─── getStoryGiftStats ───────────────────────────────────────────────

describe('getStoryGiftStats', () => {
  it('returns zeros for story with no gifts', async () => {
    mockPrisma.storyGift.groupBy.mockResolvedValue([]);

    const res = await getStoryGiftStats('story-1');

    expect(res).toEqual({ totalCoins: 0, totalGifts: 0, breakdown: [] });
  });

  it('aggregates totals across multiple gift types', async () => {
    mockPrisma.storyGift.groupBy.mockResolvedValue([
      { giftType: 'heart', _count: 3, _sum: { coinAmount: 15 } },
      { giftType: 'star', _count: 2, _sum: { coinAmount: 50 } },
      { giftType: 'crown', _count: 1, _sum: { coinAmount: 500 } },
    ]);

    const res = await getStoryGiftStats('story-1');

    expect(res.totalCoins).toBe(565);
    expect(res.totalGifts).toBe(6);
    expect(res.breakdown).toHaveLength(3);
    expect(res.breakdown[0]).toEqual({ type: 'heart', count: 3, coins: 15 });
  });

  it('handles null _sum.coinAmount gracefully', async () => {
    mockPrisma.storyGift.groupBy.mockResolvedValue([
      { giftType: 'heart', _count: 1, _sum: { coinAmount: null } },
    ]);

    const res = await getStoryGiftStats('story-1');

    expect(res.totalCoins).toBe(0);
    expect(res.breakdown[0].coins).toBe(0);
  });
});
