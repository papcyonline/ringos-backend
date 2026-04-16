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
let sessionProduction: http2.ClientHttp2Session | null = null;
let sessionSandbox: http2.ClientHttp2Session | null = null;

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

  // Use createPrivateKey for robust parsing across Node/OpenSSL versions.
  // Node 22 + OpenSSL 3 can reject raw PEM strings that older versions accept.
  const privateKey = crypto.createPrivateKey({
    key: keyPem,
    format: 'pem',
    type: 'pkcs8',
  });

  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })
  ).toString('base64url');

  const claims = Buffer.from(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })
  ).toString('base64url');

  const signer = crypto.createSign('SHA256');
  signer.update(`${header}.${claims}`);

  const signature = signer
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  const token = `${header}.${claims}.${signature}`;
  cachedJwt = { token, issuedAt: Date.now() };
  return token;
}

/**
 * Get a persistent HTTP/2 session to APNs. Maintains separate sessions for
 * production and sandbox so we can auto-fallback.
 */
function getSession(production: boolean): http2.ClientHttp2Session {
  const existing = production ? sessionProduction : sessionSandbox;
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }

  const host = production ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
  const sess = http2.connect(`https://${host}`);

  sess.on('error', (err) => {
    logger.error({ err, production }, 'APNs HTTP/2 session error');
    if (production) sessionProduction = null; else sessionSandbox = null;
  });

  sess.on('close', () => {
    if (production) sessionProduction = null; else sessionSandbox = null;
  });

  if (production) sessionProduction = sess; else sessionSandbox = sess;
  return sess;
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
/**
 * Force-close a session so the next call gets a fresh connection.
 * Used after connection errors (ECONNRESET) or Apple auth rejections.
 */
function resetSession(production: boolean) {
  const sess = production ? sessionProduction : sessionSandbox;
  if (sess && !sess.closed && !sess.destroyed) {
    try { sess.close(); } catch { /* no-op */ }
  }
  if (production) sessionProduction = null; else sessionSandbox = null;
}

/**
 * Send a single VoIP push to a specific APNs environment.
 */
function sendToEnvironment(
  deviceToken: string,
  body: string,
  jwt: string,
  production: boolean,
): Promise<{ statusCode: number; responseData: string }> {
  return new Promise((resolve) => {
    try {
      const sess = getSession(production);
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

      req.on('response', (headers) => { statusCode = headers[':status'] as number; });
      req.on('data', (chunk) => { responseData += chunk; });
      req.on('end', () => resolve({ statusCode, responseData }));
      req.on('error', (err) => {
        // Connection-level error — kill the session so the next call reconnects.
        resetSession(production);
        resolve({ statusCode: 0, responseData: `request error: ${(err as Error).message}` });
      });
      req.end(body);
    } catch (e) {
      resetSession(production);
      resolve({ statusCode: 0, responseData: `connection error: ${(e as Error).message}` });
    }
  });
}

export async function sendVoipPush(
  deviceToken: string,
  payload: Record<string, unknown>
): Promise<VoipPushResult> {
  if (!isConfigured()) {
    return { success: false };
  }

  const jwt = generateApnsJwt();
  const body = JSON.stringify({ aps: { 'content-available': 1 }, ...payload });

  // Try preferred environment first. On BadDeviceToken or
  // BadEnvironmentKeyInToken, auto-retry on the other environment.
  // This handles both dev-installed (sandbox) and TestFlight/AppStore
  // (production) apps without manual APNS_PRODUCTION toggling.
  const preferred = env.APNS_PRODUCTION;
  let result = await sendToEnvironment(deviceToken, body, jwt, preferred);

  // Retry transient connection errors once (ECONNRESET, session drops).
  if (result.statusCode === 0 && result.responseData.includes('request error')) {
    logger.warn({ deviceToken, preferred, error: result.responseData }, 'APNs connection error — retrying once');
    result = await sendToEnvironment(deviceToken, body, jwt, preferred);
  }

  if (result.statusCode !== 200) {
    const reason = result.responseData;
    if (reason.includes('BadDeviceToken') || reason.includes('BadEnvironment')) {
      logger.info({ deviceToken, preferred }, 'APNs environment mismatch — retrying on alternate');
      result = await sendToEnvironment(deviceToken, body, jwt, !preferred);
    }
  }

  if (result.statusCode === 200) {
    return { success: true };
  } else if (result.statusCode === 410) {
    logger.info({ deviceToken }, 'APNs VoIP token unregistered (410)');
    return { success: false, unregistered: true };
  } else if (result.statusCode === 403) {
    // 403 with InvalidProviderToken / BadEnvironmentKeyInToken means
    // the .p8 key itself is invalid (wrong team, revoked, or APNs
    // capability not enabled on the key). No point retrying.
    logger.error(
      {
        statusCode: result.statusCode,
        responseData: result.responseData,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
      },
      'APNs rejected auth token — .p8 key is invalid for this team. Verify key in Apple Developer portal.',
    );
    return { success: false };
  } else {
    logger.warn(
      { statusCode: result.statusCode, responseData: result.responseData, deviceToken },
      'APNs VoIP push failed',
    );
    return { success: false };
  }
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
