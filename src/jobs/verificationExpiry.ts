import { prisma } from '../config/database';
import { logger } from '../shared/logger';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

/**
 * Clears `isVerified` for accounts whose time-limited verification has expired.
 * Only touches rows where `verifiedUntil` is set AND in the past — so
 * permanent (subscription-driven) verifications, which leave `verifiedUntil`
 * NULL, are never affected.
 */
async function run() {
  const result = await prisma.user.updateMany({
    where: {
      isVerified: true,
      verifiedUntil: { not: null, lt: new Date() },
    },
    data: { isVerified: false, verifiedUntil: null, verifiedRole: null },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'Expired time-limited verifications');
  }
}

export function startVerificationExpiryJob() {
  // Run once shortly after boot, then on the interval.
  run().catch((err) => logger.error(err, 'Verification expiry job error'));
  setInterval(() => {
    run().catch((err) => logger.error(err, 'Verification expiry job error'));
  }, CHECK_INTERVAL_MS);
  logger.info('Verification expiry job started');
}
