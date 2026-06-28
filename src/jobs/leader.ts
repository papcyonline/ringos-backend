import { randomUUID } from 'crypto';
import { getRedis } from '../shared/redis.service';
import { logger } from '../shared/logger';

// Background jobs (push digests, cleanups, expiries) must run on exactly ONE
// instance — otherwise every Render dyno fires every job and users get N copies
// of each notification. We elect a single leader via a Redis lock with a TTL
// that the leader renews on a heartbeat; if the leader dies, the lock expires
// and another instance takes over.
const LOCK_KEY = 'jobs:leader';
const LOCK_TTL_SEC = 30; // lock auto-expires this long after the last renewal
const HEARTBEAT_MS = 10_000; // renew/attempt well within the TTL
const instanceId = randomUUID();

let isLeader = false;
let started = false;

/**
 * Run `onElected` exactly once, on whichever single instance wins leadership.
 *
 * - No Redis configured (single instance / local dev) → run here immediately.
 * - A current leader that loses the lock (e.g. a Redis blip it couldn't renew
 *   through) exits the process: the jobs are self-scheduled setIntervals that
 *   can't be cleanly stopped, so a clean restart as a follower is safest.
 */
export function electLeaderAndRun(onElected: () => void): void {
  const redis = getRedis();
  if (!redis) {
    logger.warn('Leader election disabled (no Redis) — running background jobs on this instance');
    runOnce(onElected);
    return;
  }

  const tick = async () => {
    try {
      const acquired = await redis.set(LOCK_KEY, instanceId, 'EX', LOCK_TTL_SEC, 'NX');
      if (acquired === 'OK') {
        becomeLeader(onElected);
        return;
      }
      const holder = await redis.get(LOCK_KEY);
      if (holder === instanceId) {
        await redis.set(LOCK_KEY, instanceId, 'EX', LOCK_TTL_SEC); // renew
        becomeLeader(onElected);
      } else if (isLeader) {
        logger.error({ instanceId }, 'Lost jobs leadership — exiting to restart as follower');
        process.exit(1);
      }
    } catch (err) {
      logger.warn({ err }, 'Leader-election heartbeat failed');
    }
  };

  void tick();
  setInterval(tick, HEARTBEAT_MS);
}

function becomeLeader(onElected: () => void) {
  if (!isLeader) {
    isLeader = true;
    logger.info({ instanceId }, 'Became jobs leader — starting background jobs');
  }
  runOnce(onElected);
}

function runOnce(onElected: () => void) {
  if (started) return;
  started = true;
  onElected();
}
