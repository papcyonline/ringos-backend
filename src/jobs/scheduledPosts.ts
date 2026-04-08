import { logger } from '../shared/logger';
import { publishScheduledPosts } from '../modules/post/post.service';

const CHECK_INTERVAL_MS = 60 * 1000; // every 1 minute

async function runPublish() {
  try {
    await publishScheduledPosts();
  } catch (err) {
    logger.error(err, 'Scheduled posts publish job error');
  }
}

export function startScheduledPostsJob() {
  runPublish();
  setInterval(runPublish, CHECK_INTERVAL_MS);
  logger.info('Scheduled posts job started (runs every 1 min)');
}
