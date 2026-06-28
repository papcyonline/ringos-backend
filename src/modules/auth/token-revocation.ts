import * as redis from '../../shared/redis.service';
import { logger } from '../../shared/logger';

// Access tokens are stateless JWTs, so they can't be revoked individually. To
// support "log out everywhere" / suspected-compromise, we record a per-user
// "valid from" epoch: any access token issued before it is rejected by the auth
// middleware. The marker's TTL must exceed the access-token lifetime
// (JWT_EXPIRES_IN, currently 1h) so it outlives every token issued before the
// revocation — after that, those tokens have expired on their own anyway.
const REVOCATION_TTL_SECONDS = 2 * 60 * 60; // 2h — comfortably > 1h token life

const key = (userId: string) => `revoke:user:${userId}`;

/**
 * Revoke ALL of a user's currently-valid access tokens (logout-all / suspected
 * compromise). Best-effort: a Redis outage is swallowed — the DB-backed refresh
 * token store stays the durable control, and access tokens expire within 1h.
 */
export async function revokeUserAccessTokens(userId: string): Promise<void> {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    await redis.set(key(userId), String(nowSec), REVOCATION_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to record access-token revocation');
  }
}

/**
 * True if an access token issued at `iat` (JWT seconds) predates a revocation
 * for this user. Fails OPEN on any Redis error so an outage can't lock everyone
 * out — revocation is a hardening layer, not the primary auth control.
 */
export async function isAccessTokenRevoked(userId: string, iat?: number): Promise<boolean> {
  if (!iat) return false;
  try {
    const epoch = await redis.get<string>(key(userId));
    if (!epoch) return false;
    return iat < parseInt(epoch, 10);
  } catch {
    return false;
  }
}
