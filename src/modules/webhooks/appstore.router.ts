import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger';
import {
  verifyAndDecodeAppleNotification,
  planFromProductId,
  describeVerificationError,
  peekPayloadClaims,
  AppleNotificationResult,
} from '../../shared/appleReceipt.service';
import { env } from '../../config/env';
import * as userService from '../user/user.service';

const router = Router();

// App Store Server Notification types that mean the subscription is (still)
// active → grant Pro.
const GRANT_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'OFFER_REDEEMED',
  'RENEWAL_EXTENDED',
  'REFUND_REVERSED',
]);
// Types that mean access is lost → revoke Pro.
const REVOKE_TYPES = new Set([
  'EXPIRED',
  'GRACE_PERIOD_EXPIRED',
  'REFUND',
  'REVOKE',
]);

function statusForRevoke(notificationType: string): string {
  switch (notificationType) {
    case 'REFUND':
      return 'refunded';
    case 'REVOKE':
      return 'revoked';
    default:
      return 'expired';
  }
}

/**
 * Resolve which of our users a notification's transaction belongs to. Primary:
 * the appAccountToken we set at purchase (= User.id). Fallback: the
 * originalTransactionId we stored on the Subscription at first verify (covers
 * purchases made before the client started tagging transactions).
 */
async function resolveUserId(
  tx: NonNullable<AppleNotificationResult['transaction']>,
): Promise<string | null> {
  if (tx.appAccountToken && (await userService.userExists(tx.appAccountToken))) {
    return tx.appAccountToken;
  }
  if (tx.originalTransactionId) {
    return userService.findUserIdBySubscriptionExternalId(tx.originalTransactionId);
  }
  return null;
}

async function handleNotification(n: AppleNotificationResult): Promise<void> {
  const { notificationType, subtype, transaction } = n;

  // App Store Connect "Send Test Notification" — signature is valid but there's
  // nothing to apply. Ack so the console shows success.
  if (notificationType === 'TEST') {
    logger.info('App Store TEST notification received & verified');
    return;
  }
  if (!transaction) {
    logger.info({ notificationType, subtype }, 'App Store notification without a transaction — ignored');
    return;
  }

  const userId = await resolveUserId(transaction);
  if (!userId) {
    logger.warn(
      { notificationType, originalTransactionId: transaction.originalTransactionId },
      'App Store notification could not be mapped to a user',
    );
    return;
  }

  const plan = planFromProductId(transaction.productId);
  const externalId = transaction.originalTransactionId;

  if (transaction.revoked || REVOKE_TYPES.has(notificationType)) {
    await userService.applyAppleSubscriptionState(userId, {
      active: false,
      status: statusForRevoke(notificationType),
      plan,
      externalId,
    });
    logger.info({ userId, notificationType }, 'App Store notification: revoked Pro');
    return;
  }

  if (GRANT_TYPES.has(notificationType)) {
    await userService.applyAppleSubscriptionState(userId, {
      active: true,
      status: 'active',
      plan,
      externalId,
    });
    logger.info({ userId, notificationType }, 'App Store notification: granted Pro');
    return;
  }

  // Neutral events (DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW while in grace,
  // PRICE_INCREASE, etc.) don't change access — leave state as-is.
  logger.info({ userId, notificationType, subtype }, 'App Store notification: no access change');
}

/**
 * App Store Server Notifications V2 webhook. Apple POSTs `{ signedPayload }`.
 * This is the authoritative, client-independent source of subscription
 * lifecycle events (purchase, renewal, refund, expiry, revoke). Set this URL in
 * App Store Connect → App Information → App Store Server Notifications (V2).
 * No shared secret: authenticity comes from the Apple-signed JWS.
 */
router.post('/appstore', async (req: Request, res: Response) => {
  const signedPayload = req.body?.signedPayload;
  if (!signedPayload || typeof signedPayload !== 'string') {
    return res.status(400).json({ error: 'missing signedPayload' });
  }

  let notification: AppleNotificationResult;
  try {
    notification = await verifyAndDecodeAppleNotification(signedPayload);
  } catch (err) {
    // Bad signature / wrong bundle / wrong environment — reject (don't ack a
    // forgery). Log the decoded status + what Apple sent vs. what we expect so a
    // config mismatch (bundleId / appAppleId) is obvious.
    logger.warn(
      {
        reason: describeVerificationError(err),
        sent: peekPayloadClaims(signedPayload),
        expected: { bundleId: env.APPLE_BUNDLE_ID, appAppleId: env.APPLE_APP_APPLE_ID },
      },
      'Rejected App Store notification (verification failed)',
    );
    return res.status(400).json({ error: 'invalid signedPayload' });
  }

  try {
    await handleNotification(notification);
  } catch (err) {
    // Our-side failure (e.g. DB) — return 500 so Apple re-delivers later.
    logger.error({ err }, 'Failed to apply App Store notification');
    return res.status(500).json({ error: 'processing failed' });
  }

  return res.sendStatus(200);
});

export default router;
