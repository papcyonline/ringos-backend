import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';

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
