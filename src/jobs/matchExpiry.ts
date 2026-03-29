import { prisma } from '../config/database';
import { getIO } from '../config/socket';
import { logger } from '../shared/logger';

const MATCH_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

export function startMatchExpiryJob() {
  setInterval(async () => {
    try {
      const expiredAt = new Date(Date.now() - MATCH_EXPIRY_MS);

      // Find requests that will expire so we can notify the users
      const expiring = await prisma.matchRequest.findMany({
        where: {
          status: 'WAITING',
          createdAt: { lt: expiredAt },
        },
        select: { id: true, userId: true },
      });

      if (expiring.length === 0) return;

      await prisma.matchRequest.updateMany({
        where: {
          id: { in: expiring.map((r) => r.id) },
          status: 'WAITING',
        },
        data: { status: 'EXPIRED' },
      });

      // Notify each user so their frontend stops showing "Searching..."
      const io = getIO();
      for (const req of expiring) {
        io.to(`user:${req.userId}`).emit('matching:timeout', {
          requestId: req.id,
          message: 'No match found. Try again later.',
        });
      }

      logger.info({ count: expiring.length }, 'Expired match requests');
    } catch (err) {
      logger.error(err, 'Match expiry job error');
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Match expiry job started');
}
