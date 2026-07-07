import fs from 'fs';
import path from 'path';
import {
  SignedDataVerifier,
  Environment,
} from '@apple/app-store-server-library';
import { env } from '../config/env';
import { logger } from './logger';

// Apple's classic receipt-validation endpoints (StoreKit 1). Always call
// production first; a receipt generated in the sandbox returns status 21007,
// which is the signal to retry against the sandbox endpoint (Apple's documented
// flow). NOTE: the current `in_app_purchase` client (in_app_purchase_storekit
// 0.4.x) defaults to StoreKit 2 and sends a *signed JWS transaction* instead of
// a classic receipt — that path is handled by validateSignedTransaction below.
// These endpoints remain only as a fallback for any legacy StoreKit 1 receipt.
const PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

// Apple root CA certificates (DER .cer). The App Store signs StoreKit 2
// transactions with a chain rooted at "Apple Root CA - G3"; the verifier checks
// the JWS against these roots so we can trust the decoded payload offline
// (no shared secret, no network round-trip to Apple required).
const APPLE_ROOT_CERTS: Buffer[] = (() => {
  const dir = path.join(__dirname, 'apple-certs');
  try {
    const certs = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.cer'))
      .map((f) => fs.readFileSync(path.join(dir, f)));
    if (certs.length === 0) {
      logger.error('No Apple root certs found in apple-certs — StoreKit 2 verification disabled');
    }
    return certs;
  } catch (err) {
    logger.error({ err }, 'Failed to load Apple root certs — StoreKit 2 verification disabled');
    return [];
  }
})();

// One verifier per environment (Production / Sandbox), built lazily and cached.
// The environment is read from the (unverified) JWS payload so TestFlight/sandbox
// purchases and live App Store purchases both validate against the right one.
const verifierCache = new Map<Environment, SignedDataVerifier>();
function getVerifier(environment: Environment): SignedDataVerifier {
  let v = verifierCache.get(environment);
  if (!v) {
    // enableOnlineChecks=false: we still verify the full signature chain to the
    // Apple root; we just skip the OCSP revocation round-trip (network dependency).
    // appAppleId (5th arg) is REQUIRED for Production-environment transactions.
    v = new SignedDataVerifier(
      APPLE_ROOT_CERTS,
      false,
      environment,
      env.APPLE_BUNDLE_ID,
      env.APPLE_APP_APPLE_ID,
    );
    verifierCache.set(environment, v);
  }
  return v;
}

// The auto-renewable subscription products we sell. A valid receipt/transaction
// must carry one of these for us to grant Pro/verification.
const OUR_PRODUCT_IDS = new Set<string>([
  'yomeet_pro_weekly',
  'yomeet_monthly',
  'yomeet_yearly',
]);

/** A StoreKit 2 JWS is three base64url segments separated by dots. */
function looksLikeJws(data: string): boolean {
  const parts = data.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Decode a JWS payload WITHOUT verifying — only to pick the right verifier
 * (Production vs Sandbox). Handles both a signed transaction (`environment` at
 * top level) and a server notification (`data.environment`). The signature is
 * still fully verified afterwards, so this peek can't be used to forge anything.
 */
function peekJwsEnvironment(jws: string): Environment {
  try {
    const payload = JSON.parse(
      Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'),
    );
    const envStr = payload.environment ?? payload.data?.environment;
    return envStr === 'Sandbox' ? Environment.SANDBOX : Environment.PRODUCTION;
  } catch {
    return Environment.PRODUCTION;
  }
}

/**
 * Validate a StoreKit 2 signed transaction (the JWS the current client sends).
 * Verifies the JWS signature chain against Apple's roots and that it belongs to
 * our bundle id, then reports whether it carries an active subscription for one
 * of our products.
 */
async function validateSignedTransaction(jws: string): Promise<AppleValidationResult> {
  if (APPLE_ROOT_CERTS.length === 0) {
    return { valid: false, active: false, reason: 'validation_not_configured' };
  }
  try {
    const environment = peekJwsEnvironment(jws);
    const verifier = getVerifier(environment);
    // Throws VerificationException if the signature/bundle id/chain is invalid.
    const tx = await verifier.verifyAndDecodeTransaction(jws);

    const productId = tx.productId;
    if (!productId || !OUR_PRODUCT_IDS.has(productId)) {
      return { valid: true, active: false, environment, reason: 'no_matching_product' };
    }

    // A refunded/revoked transaction carries revocationDate — never treat it as
    // active even if its expiry hasn't passed yet.
    if (typeof tx.revocationDate === 'number') {
      return { valid: true, active: false, productId, environment, reason: 'revoked' };
    }

    // Auto-renewable subs carry expiresDate (ms). Absent → treat as active
    // (non-expiring product) since the signature already proved the purchase.
    const expiresAtMs = typeof tx.expiresDate === 'number' ? tx.expiresDate : undefined;
    const active = expiresAtMs === undefined || expiresAtMs > Date.now();
    return {
      valid: true,
      active,
      productId,
      originalTransactionId: tx.originalTransactionId,
      expiresAtMs,
      environment,
      reason: active ? undefined : 'expired',
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'StoreKit 2 transaction verification failed');
    return { valid: false, active: false, reason: 'jws_verification_failed' };
  }
}

export interface AppleNotificationResult {
  /** e.g. SUBSCRIBED, DID_RENEW, EXPIRED, REFUND, REVOKE — see Apple's V2 types. */
  notificationType: string;
  subtype?: string;
  /** Decoded + signature-verified transaction the notification refers to. */
  transaction?: {
    productId?: string;
    /** appAccountToken we set at purchase = our User.id (maps notification → user). */
    appAccountToken?: string;
    originalTransactionId?: string;
    expiresAtMs?: number;
    /** True when the transaction has been refunded/revoked. */
    revoked: boolean;
  };
}

/**
 * Verify and decode an App Store Server Notification V2 (`{ signedPayload }`
 * webhook body). Verifies the outer notification JWS AND the inner transaction
 * JWS against Apple's roots. Throws if the signature/bundle/environment is
 * invalid (so a forged webhook is rejected). This is the authoritative,
 * client-independent source of subscription lifecycle events.
 */
export async function verifyAndDecodeAppleNotification(
  signedPayload: string,
): Promise<AppleNotificationResult> {
  if (APPLE_ROOT_CERTS.length === 0) {
    throw new Error('Apple root certs not loaded — cannot verify notifications');
  }
  const environment = peekJwsEnvironment(signedPayload);
  const verifier = getVerifier(environment);
  const decoded = await verifier.verifyAndDecodeNotification(signedPayload);

  let transaction: AppleNotificationResult['transaction'];
  const signedTx = decoded.data?.signedTransactionInfo;
  if (signedTx) {
    const tx = await verifier.verifyAndDecodeTransaction(signedTx);
    transaction = {
      productId: tx.productId,
      appAccountToken: tx.appAccountToken,
      originalTransactionId: tx.originalTransactionId,
      expiresAtMs: typeof tx.expiresDate === 'number' ? tx.expiresDate : undefined,
      revoked: typeof tx.revocationDate === 'number',
    };
  }
  return {
    notificationType: String(decoded.notificationType ?? ''),
    subtype: decoded.subtype ? String(decoded.subtype) : undefined,
    transaction,
  };
}

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
  if (!receiptData) return { valid: false, active: false, reason: 'no_receipt' };

  // The current client (StoreKit 2) sends a signed JWS transaction, not a
  // classic receipt. Route it to the signature-based verifier — this needs no
  // shared secret. Classic base64 receipts fall through to /verifyReceipt.
  if (looksLikeJws(receiptData)) {
    return validateSignedTransaction(receiptData);
  }

  if (!env.APPLE_SHARED_SECRET) {
    logger.error(
      'APPLE_SHARED_SECRET not set — cannot validate legacy iOS receipts (verification blocked)',
    );
    return { valid: false, active: false, reason: 'validation_not_configured' };
  }

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
