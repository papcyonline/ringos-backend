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

/**
 * Decrement a counter
 */
export async function decr(key: string): Promise<number | null> {
  if (!redisClient) return null;

  try {
    return await redisClient.decr(key);
  } catch (error) {
    logger.error({ error, key }, 'Redis DECR failed');
    return null;
  }
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/**
 * Check rate limit for a key
 * Returns true if within limit, false if exceeded
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  if (!redisClient) {
    // If Redis not available, allow all requests
    return { allowed: true, remaining: maxRequests, resetAt: Date.now() + windowSeconds * 1000 };
  }

  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const rateLimitKey = `ratelimit:${key}`;

  try {
    // Remove old entries
    await redisClient.zremrangebyscore(rateLimitKey, 0, windowStart);

    // Count current entries
    const count = await redisClient.zcard(rateLimitKey);

    if (count >= maxRequests) {
      // Get the oldest entry to calculate reset time
      const oldest = await redisClient.zrange(rateLimitKey, 0, 0, 'WITHSCORES');
      const resetAt = oldest.length >= 2 ? parseInt(oldest[1]) + windowSeconds * 1000 : now + windowSeconds * 1000;

      return { allowed: false, remaining: 0, resetAt };
    }

    // Add new entry
    await redisClient.zadd(rateLimitKey, now, `${now}-${Math.random()}`);
    await redisClient.expire(rateLimitKey, windowSeconds);

    return {
      allowed: true,
      remaining: maxRequests - count - 1,
      resetAt: now + windowSeconds * 1000,
    };
  } catch (error) {
    logger.error({ error, key }, 'Rate limit check failed');
    // On error, allow the request
    return { allowed: true, remaining: maxRequests, resetAt: Date.now() + windowSeconds * 1000 };
  }
}

// ─── Caching Helpers ──────────────────────────────────────────────────────────

/**
 * Get or set a cached value
 * If the key doesn't exist, calls the factory function and caches the result
 */
export async function getOrSet<T>(
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
