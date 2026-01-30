import { getIO } from '../config/socket';
import { expireAvailabilities } from '../modules/user/user.service';
import { logger } from '../shared/logger';

const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

export function startAvailabilityExpiryJob() {
  setInterval(async () => {
    try {
      const expiredIds = await expireAvailabilities();
      if (expiredIds.length > 0) {
        const io = getIO();
        for (const userId of expiredIds) {
          io.emit('user:status-update', {
            userId,
            status: 'available',
            availabilityNote: null,
            availableFor: ['text'],
            availableUntil: null,
          });
        }
        logger.info({ count: expiredIds.length }, 'Expired user availabilities');
      }
    } catch (err) {
      logger.error(err, 'Availability expiry job error');
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Availability expiry job started');
}
