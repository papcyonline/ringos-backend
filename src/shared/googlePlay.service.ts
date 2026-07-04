import { google } from 'googleapis';
import { env } from '../config/env';
import { logger } from './logger';
import { planFromProductId } from './appleReceipt.service';

// Reuse the plan mapping so both stores label plans the same way.
export { planFromProductId };

const OUR_PRODUCT_IDS = new Set<string>([
  'yomeet_pro_weekly',
  'yomeet_monthly',
  'yomeet_yearly',
]);

export interface GoogleValidationResult {
  valid: boolean;
  active: boolean;
  productId?: string;
  orderId?: string;
  expiresAtMs?: number;
  reason?: string;
}

let _client: ReturnType<typeof google.androidpublisher> | null = null;

function getClient() {
  if (_client) return _client;
  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) return null;
  try {
    const credentials = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    _client = google.androidpublisher({ version: 'v3', auth });
    return _client;
  } catch (err) {
    logger.error({ err }, 'Invalid GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    return null;
  }
}

/**
 * Validate a Google Play subscription purchase server-side and report whether
 * it's currently active. Never trusts the client's purchase token blindly.
 */
export async function validateGooglePlayPurchase(
  productId: string,
  purchaseToken: string,
): Promise<GoogleValidationResult> {
  if (!productId || !OUR_PRODUCT_IDS.has(productId)) {
    return { valid: false, active: false, reason: 'unknown_product' };
  }
  if (!purchaseToken) return { valid: false, active: false, reason: 'no_token' };

  const client = getClient();
  if (!client) {
    logger.error('Google Play validation not configured (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)');
    return { valid: false, active: false, reason: 'validation_not_configured' };
  }

  try {
    const res = await client.purchases.subscriptions.get({
      packageName: env.ANDROID_PACKAGE_NAME,
      subscriptionId: productId,
      token: purchaseToken,
    });
    const data = res.data;
    const expiresAtMs = parseInt(data.expiryTimeMillis ?? '0', 10);
    // paymentState: 1 = received, 2 = free trial. 0 = pending, 3 = deferred.
    const paymentState = data.paymentState;
    const paid = paymentState === 1 || paymentState === 2;
    const active = paid && expiresAtMs > Date.now();
    return {
      valid: true,
      active,
      productId,
      orderId: data.orderId ?? undefined,
      expiresAtMs,
      reason: active ? undefined : 'not_active',
    };
  } catch (err: any) {
    // A 400/410 from Google means the token is invalid/expired — a real
    // rejection, not an outage.
    const status = err?.code ?? err?.response?.status;
    logger.warn({ status, productId }, 'Google Play purchase validation failed');
    return { valid: false, active: false, reason: `google_error_${status ?? 'unknown'}` };
  }
}
