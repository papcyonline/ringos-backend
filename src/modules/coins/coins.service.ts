import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, NotFoundError } from '../../shared/errors';
import { createNotification } from '../notification/notification.service';

// ─── Gift Types ──────────────────────────────────────────

export const GIFT_TYPES: Record<string, number> = {
  heart: 5,
  star: 25,
  diamond: 100,
  crown: 500,
};

// ─── Get or Create Balance ───────────────────────────────

export async function getBalance(userId: string): Promise<number> {
  const balance = await prisma.coinBalance.findUnique({
    where: { userId },
  });
  return balance?.balance ?? 0;
}

async function ensureBalance(userId: string) {
  await prisma.coinBalance.upsert({
    where: { userId },
    create: { userId, balance: 0 },
    update: {},
  });
}

// ─── Purchase Coins ──────────────────────────────────────

const COIN_PACKS: Record<string, number> = {
  coins_100: 100,
  coins_500: 500,
  coins_1200: 1200,
};

export async function purchaseCoins(
  userId: string,
  packId: string
) {
  const amount = COIN_PACKS[packId];
  if (!amount) {
    throw new BadRequestError(`Invalid coin pack: ${packId}`);
  }

  await ensureBalance(userId);

  const [balance, transaction] = await prisma.$transaction([
    prisma.coinBalance.update({
      where: { userId },
      data: { balance: { increment: amount } },
    }),
    prisma.coinTransaction.create({
      data: {
        userId,
        amount,
        type: 'PURCHASE',
      },
    }),
  ]);

  logger.info({ userId, packId, amount, newBalance: balance.balance }, 'Coins purchased');
  return { balance: balance.balance, transaction };
}

// ─── Send Gift ───────────────────────────────────────────

export async function sendGift(
  senderId: string,
  storyId: string,
  giftType: string
) {
  const coinAmount = GIFT_TYPES[giftType];
  if (coinAmount === undefined) {
    throw new BadRequestError(`Invalid gift type: ${giftType}. Valid types: ${Object.keys(GIFT_TYPES).join(', ')}`);
  }

  // Verify story exists
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true, userId: true },
  });
  if (!story) throw new NotFoundError('Story not found');
  if (story.userId === senderId) {
    throw new BadRequestError('Cannot send a gift to your own story');
  }

  await ensureBalance(senderId);
  await ensureBalance(story.userId);

  // Atomic transaction: check balance, debit sender, credit recipient, record gift
  const [updatedSender] = await prisma.$transaction(async (tx) => {
    // Check balance inside transaction to prevent race condition
    const senderBalance = await tx.coinBalance.findUnique({
      where: { userId: senderId },
    });

    if (!senderBalance || senderBalance.balance < coinAmount) {
      throw new BadRequestError('Insufficient coin balance');
    }

    return Promise.all([
      tx.coinBalance.update({
        where: { userId: senderId },
        data: { balance: { decrement: coinAmount } },
      }),
      tx.coinBalance.update({
        where: { userId: story.userId },
        data: { balance: { increment: coinAmount } },
      }),
      tx.coinTransaction.create({
        data: {
          userId: senderId,
          amount: -coinAmount,
          type: 'GIFT',
          relatedStoryId: storyId,
        },
      }),
      tx.coinTransaction.create({
        data: {
          userId: story.userId,
          amount: coinAmount,
          type: 'TIP',
          relatedStoryId: storyId,
        },
      }),
      tx.storyGift.create({
        data: {
          senderId,
          recipientId: story.userId,
          storyId,
          giftType,
          coinAmount,
        },
      }),
    ]);
  });

  logger.info({ senderId, recipientId: story.userId, storyId, giftType, coinAmount }, 'Gift sent');

  // Send push notification to recipient
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { displayName: true, avatarUrl: true },
  });

  if (sender) {
    createNotification({
      userId: story.userId,
      type: 'STORY_GIFT',
      title: sender.displayName,
      body: `Sent you a ${giftType} (${coinAmount} coins) on your story`,
      imageUrl: sender.avatarUrl ?? undefined,
      data: { storyId, senderId, giftType, coinAmount },
    }).catch((err) => {
      logger.error({ err, recipientId: story.userId }, 'Failed to send gift notification');
    });
  }

  return {
    success: true,
    giftType,
    coinAmount,
    newBalance: updatedSender.balance,
  };
}

// ─── Get Gift Stats for a Story ──────────────────────────

export async function getStoryGiftStats(storyId: string) {
  const gifts = await prisma.storyGift.groupBy({
    by: ['giftType'],
    where: { storyId },
    _count: true,
    _sum: { coinAmount: true },
  });

  const totalCoins = gifts.reduce((sum, g) => sum + (g._sum.coinAmount ?? 0), 0);
  const totalGifts = gifts.reduce((sum, g) => sum + g._count, 0);

  return {
    totalCoins,
    totalGifts,
    breakdown: gifts.map((g) => ({
      type: g.giftType,
      count: g._count,
      coins: g._sum.coinAmount ?? 0,
    })),
  };
}
