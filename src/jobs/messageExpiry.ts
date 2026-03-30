import { prisma } from '../config/database';
import { logger } from '../shared/logger';

const CHECK_INTERVAL_MS = 60 * 1000; // every 60 seconds

export function startMessageExpiryJob() {
  setInterval(async () => {
    try {
      const now = new Date();
      const result = await prisma.message.deleteMany({
        where: {
          expiresAt: { lte: now },
        },
      });
      if (result.count > 0) {
        logger.info({ count: result.count }, 'Deleted expired disappearing messages');
      }
    } catch (err) {
      logger.error(err, 'Message expiry job error');
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Message expiry job started');
}
