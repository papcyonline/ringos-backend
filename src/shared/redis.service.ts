import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

// Check if Redis is configured
const isConfigured = !!env.REDIS_URL;

let redisClient: Redis | null = null;

/**
 * Initialize Redis connection
 */
export function initRedis(): Redis | null {
  if (!isConfigured) {
    logger.info('Redis not configured - caching disabled');
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  try {
    redisClient = new Redis(env.REDIS_URL!, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected');
    });

    redisClient.on('error', (error) => {
      logger.error({ error }, 'Redis error');
    });

    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
    });

    // Connect
    redisClient.connect().catch((err) => {
      logger.error({ err }, 'Failed to connect to Redis');
    });

    return redisClient;
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Redis');
    return null;
  }
}

/**
 * Get the Redis client instance
 */
export function getRedis(): Redis | null {
  return redisClient;
}

/**
 * Set a value with optional expiration
 */
export async function set(key: string, value: string | object, ttlSeconds?: number): Promise<boolean> {
  if (!redisClient) return false;

  try {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;

    if (ttlSeconds) {
      await redisClient.setex(key, ttlSeconds, stringValue);
    } else {
      await redisClient.set(key, stringValue);
    }
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Redis SET failed');
    return false;
  }
}

/**
 * Get a value
 */
export async function get<T = string>(key: string, parseJson: boolean = false): Promise<T | null> {
  if (!redisClient) return null;

  try {
    const value = await redisClient.get(key);
    if (!value) return null;

    if (parseJson) {
      return JSON.parse(value) as T;
    }
    return value as T;
  } catch (error) {
    logger.error({ error, key }, 'Redis GET failed');
    return null;
  }
}

/**
 * Delete a key
 */
export async function del(key: string): Promise<boolean> {
  if (!redisClient) return false;

  try {
    await redisClient.del(key);
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Redis DEL failed');
    return false;
  }
}

/**
 * Delete keys matching a pattern
 */
export async function delPattern(pattern: string): Promise<number> {
  if (!redisClient) return 0;

  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length === 0) return 0;

    const deleted = await redisClient.del(...keys);
    return deleted;
  } catch (error) {
    logger.error({ error, pattern }, 'Redis DEL pattern failed');
    return 0;
  }
}

/**
 * Check if a key exists
 */
export async function exists(key: string): Promise<boolean> {
  if (!redisClient) return false;

  try {
    const result = await redisClient.exists(key);
    return result === 1;
  } catch (error) {
    logger.error({ error, key }, 'Redis EXISTS failed');
    return false;
  }
}

/**
 * Set expiration on a key
 */
export async function expire(key: string, ttlSeconds: number): Promise<boolean> {
  if (!redisClient) return false;

  try {
    await redisClient.expire(key, ttlSeconds);
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Redis EXPIRE failed');
    return false;
  }
}

/**
 * Increment a counter
 */
export async function incr(key: string): Promise<number | null> {
  if (!redisClient) return null;

  try {
    return await redisClient.incr(key);
  } catch (error) {
    logger.error({ error, key }, 'Redis INCR failed');
    return null;
  }
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/**
 * Check rate limit for a key
 * Returns true if within limit, false if exceeded
 */
// In-memory fallback rate limiter when Redis is unavailable
const memoryRateLimits = new Map<string, { timestamps: number[] }>();

// Cleanup stale in-memory entries every 60s (unref so it won't block shutdown)
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryRateLimits) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 3600_000);
    if (entry.timestamps.length === 0) memoryRateLimits.delete(key);
  }
}, 60_000);
_cleanupTimer.unref();

function memoryRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  let entry = memoryRateLimits.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    memoryRateLimits.set(key, entry);
  }
  // Remove expired entries
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
  if (entry.timestamps.length >= maxRequests) {
    const resetAt = entry.timestamps[0] + windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }
  entry.timestamps.push(now);
  return { allowed: true, remaining: maxRequests - entry.timestamps.length, resetAt: now + windowMs };
}

// Atomic sliding-window rate limit. Runs the prune → count → (reject | add)
// sequence in a single Redis round-trip so concurrent requests can't both read
// a stale count and slip past the limit. Returns {allowed(0|1), remaining,
// resetAtMs}.
//   KEYS[1] = rate limit key
//   ARGV[1] = now (ms)        ARGV[2] = windowStart (ms)
//   ARGV[3] = maxRequests     ARGV[4] = windowSeconds
//   ARGV[5] = unique member
const RATE_LIMIT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
local windowMs = tonumber(ARGV[4]) * 1000
if count >= tonumber(ARGV[3]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local resetAt = tonumber(ARGV[1]) + windowMs
  if oldest[2] then resetAt = tonumber(oldest[2]) + windowMs end
  return {0, 0, resetAt}
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, tonumber(ARGV[3]) - count - 1, tonumber(ARGV[1]) + windowMs}
`;

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  if (!redisClient) {
    // Fall back to in-memory rate limiting
    return memoryRateLimit(key, maxRequests, windowSeconds);
  }

  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const rateLimitKey = `ratelimit:${key}`;

  try {
    // Single atomic round-trip — no check-then-act race under concurrency.
    const [allowed, remaining, resetAt] = (await redisClient.eval(
      RATE_LIMIT_LUA,
      1,
      rateLimitKey,
      now,
      windowStart,
      maxRequests,
      windowSeconds,
      `${now}-${Math.random()}`
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      resetAt,
    };
  } catch (error) {
    logger.error({ error, key }, 'Rate limit check failed, falling back to memory');
    return memoryRateLimit(key, maxRequests, windowSeconds);
  }
}

// ─── Caching Helpers ──────────────────────────────────────────────────────────

/**
 * Get or set a cached value
 * If the key doesn't exist, calls the factory function and caches the result
 */
export async function getOrSet<T extends string | Record<string, unknown>>(
  key: string,
  factory: () => Promise<T>,
  ttlSeconds: number = 300
): Promise<T> {
  const cached = await get<T>(key, true);
  if (cached !== null) {
    return cached;
  }

  const value = await factory();
  await set(key, value, ttlSeconds);
  return value;
}

/**
 * Cache key generators for common use cases
 */
export const cacheKeys = {
  user: (userId: string) => `user:${userId}`,
  userProfile: (userId: string) => `profile:${userId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  onlineUsers: () => 'online:users',
  userSession: (userId: string) => `session:${userId}`,
};

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}

export { isConfigured as isRedisConfigured };
