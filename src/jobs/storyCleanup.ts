import { logger } from '../shared/logger';
import { cleanupExpiredStories } from '../modules/story/story.service';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function startStoryCleanupJob() {
  setInterval(async () => {
    try {
      const count = await cleanupExpiredStories();
      if (count > 0) {
        logger.info({ count }, 'Cleaned up expired stories');
      }
    } catch (err) {
      logger.error(err, 'Story cleanup job error');
    }
  }, CHECK_INTERVAL_MS);
  logger.info('Story cleanup job started');
}
