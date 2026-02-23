import * as http2 from 'http2';
import * as crypto from 'crypto';
import { env } from './env';
import { logger } from '../shared/logger';

// ─── APNs VoIP Push (HTTP/2 + ES256 JWT) ──────────────────
// Zero npm dependencies — uses Node.js built-in http2 + crypto.

const APNS_HOST_PRODUCTION = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const JWT_VALIDITY_MS = 50 * 60 * 1000; // 50 minutes (Apple allows up to 60)

let cachedJwt: { token: string; issuedAt: number } | null = null;
let session: http2.ClientHttp2Session | null = null;

function isConfigured(): boolean {
  return !!(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY);
}

/**
 * Generate an ES256 JWT for APNs authentication.
 * Cached for 50 minutes (Apple tokens are valid for 60 min).
 */
function generateApnsJwt(): string {
  const now = Math.floor(Date.now() / 1000);

  if (cachedJwt && Date.now() - cachedJwt.issuedAt < JWT_VALIDITY_MS) {
    return cachedJwt.token;
  }

  const keyPem = Buffer.from(env.APNS_KEY!, 'base64').toString('utf8');

  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })
  ).toString('base64url');

  const claims = Buffer.from(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })
  ).toString('base64url');

  const signer = crypto.createSign('SHA256');
  signer.update(`${header}.${claims}`);

  const signature = signer
    .sign({ key: keyPem, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  const token = `${header}.${claims}.${signature}`;
  cachedJwt = { token, issuedAt: Date.now() };
  return token;
}

/**
 * Get a persistent HTTP/2 session to APNs. Auto-reconnects on close/error.
 */
function getSession(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) {
    return session;
  }

  const host = env.APNS_PRODUCTION
    ? APNS_HOST_PRODUCTION
    : APNS_HOST_SANDBOX;

  session = http2.connect(`https://${host}`);

  session.on('error', (err) => {
    logger.error({ err }, 'APNs HTTP/2 session error');
    session = null;
  });

  session.on('close', () => {
    session = null;
  });

  return session;
}

export interface VoipPushResult {
  success: boolean;
  unregistered?: boolean;
}

/**
 * Send a VoIP push notification to a single iOS device via APNs HTTP/2.
 *
 * Returns { success: true } on 200, or { success: false, unregistered: true }
 * on 410 (token should be deleted).
 *
 * Graceful no-op if APNs env vars are not configured.
 */
export async function sendVoipPush(
  deviceToken: string,
  payload: Record<string, unknown>
): Promise<VoipPushResult> {
  if (!isConfigured()) {
    return { success: false };
  }

  const jwt = generateApnsJwt();
  const body = JSON.stringify({ aps: { 'content-available': 1 }, ...payload });

  return new Promise<VoipPushResult>((resolve) => {
    try {
      const sess = getSession();

      const req = sess.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${jwt}`,
        'apns-topic': 'com.yomeet.live.voip',
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': '0',
        'content-type': 'application/json',
      });

      req.setEncoding('utf8');
      let responseData = '';
      let statusCode = 0;

      req.on('response', (headers) => {
        statusCode = headers[':status'] as number;
      });

      req.on('data', (chunk) => {
        responseData += chunk;
      });

      req.on('end', () => {
        if (statusCode === 200) {
          resolve({ success: true });
        } else if (statusCode === 410) {
          logger.info({ deviceToken }, 'APNs VoIP token unregistered (410)');
          resolve({ success: false, unregistered: true });
        } else {
          logger.warn(
            { statusCode, responseData, deviceToken },
            'APNs VoIP push failed'
          );
          resolve({ success: false });
        }
      });

      req.on('error', (err) => {
        logger.error({ err, deviceToken }, 'APNs VoIP push request error');
        resolve({ success: false });
      });

      req.end(body);
    } catch (err) {
      logger.error({ err, deviceToken }, 'APNs VoIP push error');
      resolve({ success: false });
    }
  });
}

// Log configuration status at module load
if (isConfigured()) {
  logger.info(
    { production: env.APNS_PRODUCTION },
    'APNs VoIP push configured'
  );
} else {
  logger.info('APNs not configured — VoIP push will be skipped');
}
