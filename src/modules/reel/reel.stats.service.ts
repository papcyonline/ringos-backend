import { prisma } from '../../config/database';
import { ForbiddenError, NotFoundError } from '../../shared/errors';

export interface ReelStats {
  reelId: string;
  posted: Date;
  totals: {
    views: number;
    uniqueViewers: number;
    likes: number;
    comments: number;
    reposts: number;
  };
  watch: {
    avgWatchedSec: number;
    completionRate: number; // 0..1
    completedCount: number;
  };
  engagementRate: number; // (likes + comments + reposts) / views, 0..1
  viewsPerDay: { date: string; count: number }[]; // last 7 days, oldest → newest
}

const DAYS_BACK = 7;

/**
 * Compute analytics for a single reel. Only the reel's owner is allowed.
 * Aggregates run in parallel where independent.
 */
export async function getReelStats(
  reelId: string,
  requesterId: string,
): Promise<ReelStats> {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      repostCount: true,
    },
  });
  if (!reel) throw new NotFoundError('Reel not found');
  if (reel.userId !== requesterId) {
    throw new ForbiddenError('Stats are private to the reel owner');
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (DAYS_BACK - 1));

  const [watchAgg, completedCount, uniqueViewers, perDayRows] =
    await Promise.all([
      prisma.reelView.aggregate({
        where: { reelId },
        _avg: { watchedSec: true },
        _count: { id: true },
      }),
      prisma.reelView.count({ where: { reelId, completed: true } }),
      prisma.reelView.count({ where: { reelId } }),
      prisma.$queryRaw<{ date: Date; count: bigint }[]>`
        SELECT DATE_TRUNC('day', "viewedAt") AS date, COUNT(*)::bigint AS count
        FROM "ReelView"
        WHERE "reelId" = ${reelId}
          AND "viewedAt" >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    ]);

  const totalViewerRecords = watchAgg._count.id;
  const completionRate =
    totalViewerRecords > 0 ? completedCount / totalViewerRecords : 0;
  const interactions = reel.likeCount + reel.commentCount + reel.repostCount;
  const engagementRate =
    reel.viewCount > 0 ? interactions / reel.viewCount : 0;

  // Pad missing days with 0 so the chart has 7 contiguous buckets.
  const byDate = new Map<string, number>();
  for (const row of perDayRows) {
    byDate.set(row.date.toISOString().slice(0, 10), Number(row.count));
  }
  const viewsPerDay: { date: string; count: number }[] = [];
  for (let i = 0; i < DAYS_BACK; i += 1) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    viewsPerDay.push({ date: key, count: byDate.get(key) ?? 0 });
  }

  return {
    reelId: reel.id,
    posted: reel.createdAt,
    totals: {
      views: reel.viewCount,
      uniqueViewers,
      likes: reel.likeCount,
      comments: reel.commentCount,
      reposts: reel.repostCount,
    },
    watch: {
      avgWatchedSec: Math.round((watchAgg._avg.watchedSec ?? 0) * 10) / 10,
      completionRate: Math.round(completionRate * 1000) / 1000,
      completedCount,
    },
    engagementRate: Math.round(engagementRate * 1000) / 1000,
    viewsPerDay,
  };
}
