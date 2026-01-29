import { prisma } from '../config/database';
import { logger } from '../shared/logger';

const STALE_SESSION_HOURS = 24;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startSessionCleanupJob() {
  setInterval(async () => {
    try {
      const staleAt = new Date(Date.now() - STALE_SESSION_HOURS * 60 * 60 * 1000);
      const result = await prisma.aiSession.updateMany({
        where: {
          status: 'ACTIVE',
          updatedAt: { lt: staleAt },
        },
        data: { status: 'ENDED' },
      });
      if (result.count > 0) {
        logger.info({ count: result.count }, 'Cleaned up stale AI sessions');
      }
    } catch (err) {
      logger.error(err, 'Session cleanup job error');
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Session cleanup job started');
}
