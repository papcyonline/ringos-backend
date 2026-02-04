import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { prisma } from '../../config/database';
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
  getSubscription,
  isStripeConfigured,
} from '../../shared/stripe.service';
import { logger } from '../../shared/logger';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createCheckoutSchema = z.object({
  priceId: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  trialDays: z.number().int().positive().optional(),
});

const createPortalSchema = z.object({
  returnUrl: z.string().url(),
});

// ─── Webhook (must be before body parsers) ───────────────────────────────────

// Note: This route needs raw body, so it should be mounted before express.json()
// in app.ts, or use express.raw() middleware specifically for this route
router.post(
  '/webhook',
  async (req: Request, res: Response) => {
    if (!isStripeConfigured) {
      res.status(503).json({ error: 'Stripe not configured' });
      return;
    }

    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    try {
      const result = await handleWebhook(req.body, signature);
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'Webhook error');
      res.status(400).json({ error: 'Webhook error' });
    }
  }
);

// ─── Create Checkout Session ─────────────────────────────────────────────────

router.post(
  '/checkout',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    if (!isStripeConfigured) {
      res.status(503).json({ error: 'Stripe not configured' });
      return;
    }

    const parsed = createCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user?.email) {
      res.status(400).json({ error: 'User email required for checkout' });
      return;
    }

    try {
      const url = await createCheckoutSession({
        userId,
        email: user.email,
        priceId: parsed.data.priceId,
        successUrl: parsed.data.successUrl,
        cancelUrl: parsed.data.cancelUrl,
        trialDays: parsed.data.trialDays,
      });

      if (!url) {
        res.status(500).json({ error: 'Failed to create checkout session' });
        return;
      }

      res.json({ url });
    } catch (error) {
      logger.error({ error }, 'Checkout error');
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  }
);

// ─── Create Portal Session ───────────────────────────────────────────────────

router.post(
  '/portal',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    if (!isStripeConfigured) {
      res.status(503).json({ error: 'Stripe not configured' });
      return;
    }

    const parsed = createPortalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });

    if (!user?.stripeCustomerId) {
      res.status(400).json({ error: 'No subscription found' });
      return;
    }

    try {
      const url = await createPortalSession({
        customerId: user.stripeCustomerId,
        returnUrl: parsed.data.returnUrl,
      });

      if (!url) {
        res.status(500).json({ error: 'Failed to create portal session' });
        return;
      }

      res.json({ url });
    } catch (error) {
      logger.error({ error }, 'Portal error');
      res.status(500).json({ error: 'Failed to create portal session' });
    }
  }
);

// ─── Get Subscription Status ─────────────────────────────────────────────────

router.get(
  '/status',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionId: true,
        subscriptionStatus: true,
        subscriptionPlan: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Get detailed subscription info from Stripe if available
    let subscription = null;
    if (user.subscriptionId && isStripeConfigured) {
      subscription = await getSubscription(user.subscriptionId);
    }

    res.json({
      subscriptionId: user.subscriptionId,
      status: user.subscriptionStatus,
      plan: user.subscriptionPlan,
      currentPeriodEnd: (subscription as any)?.current_period_end
        ? new Date((subscription as any).current_period_end * 1000).toISOString()
        : null,
      cancelAtPeriodEnd: (subscription as any)?.cancel_at_period_end ?? false,
    });
  }
);

export { router as subscriptionRouter };
