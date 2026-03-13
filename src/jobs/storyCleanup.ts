import { logger } from '../shared/logger';
import { cleanupExpiredStories } from '../modules/story/story.service';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

async function runCleanup() {
  try {
    const count = await cleanupExpiredStories();
    if (count > 0) {
      logger.info({ count }, 'Cleaned up expired stories');
    }
  } catch (err) {
    logger.error(err, 'Story cleanup job error');
  }
}

export function startStoryCleanupJob() {
  // Run immediately on startup to catch any stories that expired while server was down
  runCleanup();
  setInterval(runCleanup, CHECK_INTERVAL_MS);
  logger.info('Story cleanup job started (runs every 10 min)');
}
