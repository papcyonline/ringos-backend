import { env } from '../config/env';
import { logger } from './logger';

// Apple's classic receipt-validation endpoints (StoreKit 1 — matches the
// client's `in_app_purchase` package). Always call production first; a receipt
// generated in the sandbox returns status 21007, which is the signal to retry
// against the sandbox endpoint (Apple's documented flow).
const PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

// The auto-renewable subscription products we sell. A valid receipt must
// contain one of these for us to grant Pro/verification.
const OUR_PRODUCT_IDS = new Set<string>([
  'yomeet_pro_weekly',
  'yomeet_monthly',
  'yomeet_yearly',
]);

export interface AppleValidationResult {
  /** Apple accepted the receipt (status 0). */
  valid: boolean;
  /** A subscription for one of our products is currently active (not expired). */
  active: boolean;
  productId?: string;
  originalTransactionId?: string;
  expiresAtMs?: number;
  environment?: string;
  /** Machine-readable failure reason when not valid/active. */
  reason?: string;
}

export function planFromProductId(productId?: string): string {
  switch (productId) {
    case 'yomeet_pro_weekly':
      return 'weekly';
    case 'yomeet_monthly':
      return 'monthly';
    case 'yomeet_yearly':
      return 'yearly';
    default:
      return 'pro';
  }
}

async function callApple(url: string, receiptData: string): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receiptData,
      password: env.APPLE_SHARED_SECRET,
      'exclude-old-transactions': true,
    }),
  });
  return res.json();
}

/**
 * Validate an App Store receipt with Apple and report whether it carries an
 * active subscription for one of our products. Never trusts the client — this
 * is the server-side gate for granting Pro/verification.
 */
export async function validateAppleReceipt(
  receiptData: string,
): Promise<AppleValidationResult> {
  if (!env.APPLE_SHARED_SECRET) {
    logger.error(
      'APPLE_SHARED_SECRET not set — cannot validate iOS receipts (verification blocked)',
    );
    return { valid: false, active: false, reason: 'validation_not_configured' };
  }
  if (!receiptData) return { valid: false, active: false, reason: 'no_receipt' };

  try {
    let body = await callApple(PROD_URL, receiptData);
    if (body.status === 21007) {
      // Sandbox receipt sent to production — retry sandbox.
      body = await callApple(SANDBOX_URL, receiptData);
    }
    if (body.status !== 0) {
      return { valid: false, active: false, reason: `apple_status_${body.status}` };
    }

    const environment = body.environment as string | undefined;
    const infos: any[] = Array.isArray(body.latest_receipt_info)
      ? body.latest_receipt_info
      : Array.isArray(body.receipt?.in_app)
        ? body.receipt.in_app
        : [];

    // Pick the transaction (for one of our products) with the latest expiry.
    let best: {
      productId: string;
      originalTransactionId: string;
      expiresAtMs: number;
    } | null = null;
    for (const t of infos) {
      const productId = t.product_id as string | undefined;
      if (!productId || !OUR_PRODUCT_IDS.has(productId)) continue;
      const expiresAtMs = parseInt(t.expires_date_ms ?? '0', 10);
      if (!best || expiresAtMs > best.expiresAtMs) {
        best = {
          productId,
          originalTransactionId: (t.original_transaction_id as string) ?? '',
          expiresAtMs,
        };
      }
    }

    if (!best) {
      return { valid: true, active: false, environment, reason: 'no_matching_product' };
    }
    const active = best.expiresAtMs > Date.now();
    return {
      valid: true,
      active,
      productId: best.productId,
      originalTransactionId: best.originalTransactionId,
      expiresAtMs: best.expiresAtMs,
      environment,
      reason: active ? undefined : 'expired',
    };
  } catch (err) {
    logger.error({ err }, 'Apple receipt validation request failed');
    return { valid: false, active: false, reason: 'network_error' };
  }
}
