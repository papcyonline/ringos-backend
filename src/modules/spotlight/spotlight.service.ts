import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { isUserInCall } from '../call/call.gateway';

// Re-export for use in gateway and router without direct coupling
export { isUserInCall };

// ─── SpotlightLog CRUD ─────────────────────────────────────

export async function createSpotlightLog(broadcasterId: string, note?: string): Promise<string> {
  const log = await prisma.spotlightLog.create({
    data: { broadcasterId, note },
  });
  logger.info({ logId: log.id, broadcasterId }, 'SpotlightLog created');
  return log.id;
}

export async function endSpotlightLog(
  logId: string,
  stats: { peakViewers: number; totalViewers: number; connectCount: number },
): Promise<void> {
  try {
    await prisma.spotlightLog.update({
      where: { id: logId },
      data: {
        endedAt: new Date(),
        peakViewers: stats.peakViewers,
        totalViewers: stats.totalViewers,
        connectCount: stats.connectCount,
      },
    });
    logger.info({ logId, ...stats }, 'SpotlightLog ended');
  } catch (err) {
    logger.error({ err, logId }, 'Failed to end SpotlightLog');
  }
}

// ─── Block list helper (DRY — used by gateway + router) ────

export async function getBlockedUserIds(userId: string): Promise<Set<string>> {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  const blocked = new Set<string>();
  for (const b of blocks) {
    blocked.add(b.blockerId === userId ? b.blockedId : b.blockerId);
  }
  return blocked;
}

// ─── Broadcaster list builder (DRY — used by gateway + router) ──

interface BroadcasterListEntry {
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  note: string | null;
  isVerified: boolean;
  location: string | null;
  startedAt: Date;
  viewerCount: number;
}

export async function buildBroadcasterList(
  liveBroadcasters: Map<string, BroadcasterListEntry>,
  requesterId: string,
  blockedIds: Set<string>,
): Promise<Array<{
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  note: string | null;
  isVerified: boolean;
  location: string | null;
  viewerCount: number;
  startedAt: string;
  isLiked: boolean;
  isFollowed: boolean;
  followerCount: number;
  likeCount: number;
}>> {
  const broadcasterIds = Array.from(liveBroadcasters.keys())
    .filter((id) => id !== requesterId && !blockedIds.has(id) && !isUserInCall(id));

  // Batch-fetch requester relationships + broadcaster counts in parallel
  const [likes, follows, followerCounts, likeCounts] = await Promise.all([
    prisma.like.findMany({
      where: { likerId: requesterId, likedId: { in: broadcasterIds } },
      select: { likedId: true },
    }),
    prisma.follow.findMany({
      where: { followerId: requesterId, followingId: { in: broadcasterIds } },
      select: { followingId: true },
    }),
    prisma.follow.groupBy({
      by: ['followingId'],
      where: { followingId: { in: broadcasterIds } },
      _count: true,
    }),
    prisma.like.groupBy({
      by: ['likedId'],
      where: { likedId: { in: broadcasterIds } },
      _count: true,
    }),
  ]);

  const likedSet = new Set(likes.map((l) => l.likedId));
  const followedSet = new Set(follows.map((f) => f.followingId));
  const followerMap = new Map(followerCounts.map((r) => [r.followingId, r._count]));
  const likeMap = new Map(likeCounts.map((r) => [r.likedId, r._count]));

  return broadcasterIds.map((id) => {
    const entry = liveBroadcasters.get(id)!;
    return {
      userId: id,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl,
      bio: entry.bio,
      note: entry.note,
      isVerified: entry.isVerified,
      location: entry.location,
      viewerCount: entry.viewerCount,
      startedAt: entry.startedAt.toISOString(),
      isLiked: likedSet.has(id),
      isFollowed: followedSet.has(id),
      followerCount: followerMap.get(id) ?? 0,
      likeCount: likeMap.get(id) ?? 0,
    };
  });
}

// ─── Find-or-create 1-on-1 conversation (ACID-safe) ────────

export async function findOrCreateConversation(
  userIdA: string,
  userIdB: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // Find existing 1-on-1 conversation that contains BOTH users
    const existing = await tx.conversation.findFirst({
      where: {
        type: 'HUMAN_MATCHED',
        AND: [
          { participants: { some: { userId: userIdA } } },
          { participants: { some: { userId: userIdB } } },
        ],
      },
      include: { participants: { select: { userId: true } } },
    });

    // Verify it's truly 1-on-1 (exactly 2 participants)
    if (existing && existing.participants.length === 2) {
      return existing.id;
    }

    // Create new conversation
    const conversation = await tx.conversation.create({
      data: {
        type: 'HUMAN_MATCHED',
        participants: {
          create: [
            { userId: userIdA, role: 'MEMBER' },
            { userId: userIdB, role: 'MEMBER' },
          ],
        },
      },
    });

    return conversation.id;
  });
}

// ─── Block check helper ────────────────────────────────────

export async function areUsersBlocked(userIdA: string, userIdB: string): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userIdA, blockedId: userIdB },
        { blockerId: userIdB, blockedId: userIdA },
      ],
    },
  });
  return block !== null;
}
