import { prisma } from '../config/database';
import { logger } from '../shared/logger';

const CREATED_AT_MIN_AGE_HOURS = 24;
const LAST_SEEN_INACTIVE_DAYS = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Periodically deletes users who started signup but never completed profile
 * setup. To avoid deleting users mid-flow we require BOTH:
 *
 *   1. The account is at least 24h old (`createdAt`).
 *   2. The user has not returned in the last 7 days (`lastSeenAt` null OR
 *      older than 7 days). A user who keeps re-opening the app is treated
 *      as "still trying to onboard" and is preserved.
 *
 * All FKs that reference User use ON DELETE CASCADE, so this single delete
 * cleans up any related rows (Stories, Messages, Tokens, etc.).
 */
export function startAbandonedSignupCleanupJob() {
  const run = async () => {
    try {
      const createdBefore = new Date(
        Date.now() - CREATED_AT_MIN_AGE_HOURS * 60 * 60 * 1000,
      );
      const lastSeenBefore = new Date(
        Date.now() - LAST_SEEN_INACTIVE_DAYS * 24 * 60 * 60 * 1000,
      );
      const result = await prisma.user.deleteMany({
        where: {
          isAnonymous: true,
          createdAt: { lt: createdBefore },
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lt: lastSeenBefore } },
          ],
        },
      });
      if (result.count > 0) {
        logger.info({ count: result.count }, 'Cleaned up abandoned signups');
      }
    } catch (err) {
      logger.error(err, 'Abandoned signup cleanup job error');
    }
  };

  // Run once at startup, then every hour.
  run();
  setInterval(run, CHECK_INTERVAL_MS);

  logger.info('Abandoned signup cleanup job started');
}
