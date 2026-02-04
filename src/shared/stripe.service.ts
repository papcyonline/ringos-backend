import Stripe from 'stripe';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from '../config/database';

// Initialize Stripe if credentials are configured
const isConfigured = !!env.STRIPE_SECRET_KEY;

const stripe = isConfigured
  ? new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })
  : null;

if (isConfigured) {
  logger.info('Stripe configured');
}

export interface CreateCheckoutOptions {
  userId: string;
  email: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
}

export interface CreatePortalOptions {
  customerId: string;
  returnUrl: string;
}

/**
 * Create or retrieve a Stripe customer for a user
 */
export async function getOrCreateCustomer(userId: string, email: string): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not configured');
    return null;
  }

  // Check if user already has a Stripe customer ID
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });

  if (user?.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  // Create new Stripe customer
  try {
    const customer = await stripe.customers.create({
      email,
      metadata: { userId },
    });

    // Save customer ID to user
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customer.id },
    });

    logger.info({ userId, customerId: customer.id }, 'Stripe customer created');
    return customer.id;
  } catch (error) {
    logger.error({ error, userId }, 'Failed to create Stripe customer');
    throw error;
  }
}

/**
 * Create a checkout session for subscription
 */
export async function createCheckoutSession(
  options: CreateCheckoutOptions
): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not configured');
    return null;
  }

  const customerId = await getOrCreateCustomer(options.userId, options.email);
  if (!customerId) return null;

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: options.priceId,
          quantity: 1,
        },
      ],
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      subscription_data: options.trialDays
        ? { trial_period_days: options.trialDays }
        : undefined,
      metadata: { userId: options.userId },
    });

    logger.info({ userId: options.userId, sessionId: session.id }, 'Checkout session created');
    return session.url;
  } catch (error) {
    logger.error({ error }, 'Failed to create checkout session');
    throw error;
  }
}

/**
 * Create a billing portal session for managing subscriptions
 */
export async function createPortalSession(options: CreatePortalOptions): Promise<string | null> {
  if (!stripe) {
    logger.warn('Stripe not configured');
    return null;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: options.customerId,
      return_url: options.returnUrl,
    });

    return session.url;
  } catch (error) {
    logger.error({ error }, 'Failed to create portal session');
    throw error;
  }
}

/**
 * Cancel a subscription
 */
export async function cancelSubscription(subscriptionId: string): Promise<boolean> {
  if (!stripe) {
    logger.warn('Stripe not configured');
    return false;
  }

  try {
    await stripe.subscriptions.cancel(subscriptionId);
    logger.info({ subscriptionId }, 'Subscription cancelled');
    return true;
  } catch (error) {
    logger.error({ error, subscriptionId }, 'Failed to cancel subscription');
    return false;
  }
}

/**
 * Get subscription details
 */
export async function getSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
  if (!stripe) {
    return null;
  }

  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    logger.error({ error, subscriptionId }, 'Failed to get subscription');
    return null;
  }
}

/**
 * Handle Stripe webhook events
 */
export async function handleWebhook(
  payload: Buffer,
  signature: string
): Promise<{ received: boolean; type?: string }> {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    logger.warn('Stripe webhook not configured');
    return { received: false };
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    logger.error({ error }, 'Webhook signature verification failed');
    throw error;
  }

  logger.info({ type: event.type }, 'Stripe webhook received');

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutComplete(session);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionUpdate(subscription);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionCancelled(subscription);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      await handlePaymentFailed(invoice);
      break;
    }

    default:
      logger.debug({ type: event.type }, 'Unhandled webhook event');
  }

  return { received: true, type: event.type };
}

async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) return;

  const subscriptionId = session.subscription as string;

  await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionId,
      subscriptionStatus: 'active',
      subscriptionPlan: 'premium',
    },
  });

  logger.info({ userId, subscriptionId }, 'Subscription activated');
}

async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
  });

  if (!user) return;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: subscription.status,
    },
  });

  logger.info({ userId: user.id, status: subscription.status }, 'Subscription updated');
}

async function handleSubscriptionCancelled(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
  });

  if (!user) return;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionId: null,
      subscriptionStatus: 'cancelled',
      subscriptionPlan: null,
    },
  });

  logger.info({ userId: user.id }, 'Subscription cancelled');
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
  });

  if (!user) return;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: 'past_due',
    },
  });

  logger.info({ userId: user.id }, 'Payment failed - subscription past due');
}

export { isConfigured as isStripeConfigured };
