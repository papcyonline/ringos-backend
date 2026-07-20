import { logger } from '../shared/logger';
import { pruneExpiredVisitors } from '../modules/widget/widget.service';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const BATCH = 500; // pruneExpiredVisitors deletes at most this many per call
const MAX_BATCHES = 40; // safety cap so one run can't loop forever

// Drain expired website-widget visitors (and their shadow users) in batches so
// a backlog clears in a single run instead of leaking one batch per interval.
async function runCleanup() {
  try {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const count = await pruneExpiredVisitors();
      total += count;
      if (count < BATCH) break; // partial batch → nothing left to drain
    }
    if (total > 0) {
      logger.info({ count: total }, 'Pruned expired widget visitors');
    }
  } catch (err) {
    logger.error(err, 'Widget visitor cleanup job error');
  }
}

export function startWidgetVisitorCleanupJob() {
  runCleanup(); // catch up on anything that expired while the server was down
  setInterval(runCleanup, CHECK_INTERVAL_MS);
  logger.info('Widget visitor cleanup job started (runs every 6h)');
}
