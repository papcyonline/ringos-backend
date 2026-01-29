import { prisma } from '../config/database';
import { logger } from '../shared/logger';

const MATCH_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

export function startMatchExpiryJob() {
  setInterval(async () => {
    try {
      const expiredAt = new Date(Date.now() - MATCH_EXPIRY_MS);
      const result = await prisma.matchRequest.updateMany({
        where: {
          status: 'WAITING',
          createdAt: { lt: expiredAt },
        },
        data: { status: 'EXPIRED' },
      });
      if (result.count > 0) {
        logger.info({ count: result.count }, 'Expired match requests');
      }
    } catch (err) {
      logger.error(err, 'Match expiry job error');
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Match expiry job started');
}
