import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';

const router = Router();

/**
 * Verify RevenueCat webhook signature.
 * RevenueCat sends an `Authorization` header with the webhook secret.
 */
function verifySignature(req: Request): boolean {
  const secret = env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('REVENUECAT_WEBHOOK_SECRET not configured — skipping verification');
    return true;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

/**
 * POST /webhooks/revenuecat
 *
 * Handles RevenueCat server-to-server webhook events for subscription
 * lifecycle: purchases, renewals, cancellations, expirations, etc.
 *
 * RevenueCat event types:
 *   INITIAL_PURCHASE, RENEWAL, CANCELLATION, UNCANCELLATION,
 *   EXPIRATION, BILLING_ISSUE, PRODUCT_CHANGE, SUBSCRIBER_ALIAS,
 *   TRANSFER, NON_RENEWING_PURCHASE
 */
router.post('/revenuecat', async (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    logger.warn('RevenueCat webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const event = req.body?.event;
    if (!event) {
      return res.status(400).json({ error: 'Missing event payload' });
    }

    const {
      type,
      app_user_id,
      product_id,
      entitlement_ids,
      expiration_at_ms,
    } = event;

    logger.info({ type, app_user_id, product_id }, 'RevenueCat webhook received');

    // app_user_id is the userId we set during RevenueCat.init()
    const userId = app_user_id;
    if (!userId || userId.startsWith('$RCAnonymousID')) {
      // Anonymous user — can't map to our DB
      logger.warn({ app_user_id }, 'RevenueCat webhook: anonymous user, skipping');
      return res.json({ success: true });
    }

    // Check user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      logger.warn({ userId }, 'RevenueCat webhook: user not found');
      return res.json({ success: true });
    }

    // Determine subscription status based on event type
    const activeEvents = [
      'INITIAL_PURCHASE',
      'RENEWAL',
      'UNCANCELLATION',
      'NON_RENEWING_PURCHASE',
    ];
    const inactiveEvents = ['EXPIRATION'];
    const warningEvents = ['CANCELLATION', 'BILLING_ISSUE'];

    if (activeEvents.includes(type)) {
      // Activate subscription
      await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          externalId: product_id,
          status: 'active',
          plan: 'pro',
        },
        update: {
          externalId: product_id,
          status: 'active',
          plan: 'pro',
        },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { isVerified: true, verifiedAt: new Date() },
      });
      logger.info({ userId, type, product_id }, 'Subscription activated');

    } else if (inactiveEvents.includes(type)) {
      // Deactivate subscription
      await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          externalId: product_id,
          status: 'expired',
          plan: 'pro',
        },
        update: {
          status: 'expired',
        },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { isVerified: false, verifiedAt: null },
      });
      logger.info({ userId, type }, 'Subscription expired');

    } else if (warningEvents.includes(type)) {
      // Mark as at-risk but don't deactivate yet
      const status = type === 'CANCELLATION' ? 'cancelled' : 'past_due';
      await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          externalId: product_id,
          status,
          plan: 'pro',
        },
        update: { status },
      });
      logger.info({ userId, type, status }, 'Subscription status updated');

    } else {
      logger.debug({ type, userId }, 'RevenueCat webhook: unhandled event type');
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'RevenueCat webhook processing error');
    // Return 200 so RevenueCat doesn't retry on our errors
    res.json({ success: true });
  }
});

export { router as webhooksRouter };
