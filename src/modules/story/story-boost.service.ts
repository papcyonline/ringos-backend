import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { isPro } from '../../shared/usage.service';

// ─── Boost Tiers ─────────────────────────────────────────

const BOOST_TIERS: Record<string, { durationHours: number }> = {
  basic: { durationHours: 24 },
  premium: { durationHours: 24 },
};

// Pro-only feature. No payment step — access is gated by active Pro subscription.
// Weekly cap prevents a single Pro user from monopolising the boosted slot.
const MAX_BOOSTS_PER_WEEK = 3;

// ─── Create Boost ────────────────────────────────────────

export async function createBoost(
  storyId: string,
  userId: string,
  tier: string = 'basic'
) {
  const tierConfig = BOOST_TIERS[tier];
  if (!tierConfig) {
    throw new BadRequestError(`Invalid boost tier: ${tier}`);
  }

  // Pro gate
  if (!(await isPro(userId))) {
    throw new ForbiddenError('Boosting stories is a Pro feature');
  }

  // Verify story exists and belongs to user
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true, userId: true, expiresAt: true },
  });

  if (!story) throw new NotFoundError('Story not found');
  if (story.userId !== userId) throw new ForbiddenError('Can only boost your own stories');

  // Check story hasn't expired
  if (story.expiresAt <= new Date()) {
    throw new BadRequestError('Cannot boost an expired story');
  }

  // Check if story already has an active boost
  const existingBoost = await prisma.storyBoost.findFirst({
    where: {
      storyId,
      expiresAt: { gt: new Date() },
    },
  });

  if (existingBoost) {
    throw new BadRequestError('Story already has an active boost');
  }

  // Weekly cap across all of this user's boosts
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentBoosts = await prisma.storyBoost.count({
    where: { userId, createdAt: { gte: weekAgo } },
  });
  if (recentBoosts >= MAX_BOOSTS_PER_WEEK) {
    throw new BadRequestError(
      `Weekly boost limit reached (${MAX_BOOSTS_PER_WEEK}). Try again in a few days.`,
    );
  }

  const expiresAt = new Date(Date.now() + tierConfig.durationHours * 60 * 60 * 1000);

  const boost = await prisma.storyBoost.create({
    data: {
      storyId,
      userId,
      tier,
      expiresAt,
    },
  });

  logger.info({ boostId: boost.id, storyId, userId, tier }, 'Story boost created');
  invalidateBoostCache();
  return boost;
}

// ─── Get Boost Status ────────────────────────────────────

export async function getBoostStatus(storyId: string) {
  const boost = await prisma.storyBoost.findFirst({
    where: {
      storyId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!boost) {
    return { isBoosted: false };
  }

  return {
    isBoosted: true,
    tier: boost.tier,
    expiresAt: boost.expiresAt,
    startedAt: boost.startedAt,
  };
}

// ─── Get Boosted Story IDs (for feed sorting) ────────────
// Cached for 60s since boosts change infrequently.

let boostedCache: { data: Map<string, string>; expiresAt: number } | null = null;
const BOOST_CACHE_TTL_MS = 60_000;

export async function getBoostedStoryIds(): Promise<Map<string, string>> {
  if (boostedCache && boostedCache.expiresAt > Date.now()) {
    return boostedCache.data;
  }

  const activeBoosts = await prisma.storyBoost.findMany({
    where: {
      expiresAt: { gt: new Date() },
    },
    select: {
      storyId: true,
      tier: true,
    },
  });

  const boostMap = new Map<string, string>();
  for (const boost of activeBoosts) {
    boostMap.set(boost.storyId, boost.tier);
  }

  boostedCache = { data: boostMap, expiresAt: Date.now() + BOOST_CACHE_TTL_MS };
  return boostMap;
}

export function invalidateBoostCache() {
  boostedCache = null;
}
