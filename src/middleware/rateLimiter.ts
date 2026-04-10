import { Request, Response, NextFunction } from 'express';
import { TooManyRequestsError } from '../shared/errors';
import { checkRateLimit } from '../shared/redis.service';

/**
 * Distributed rate limiter (Redis-backed, falls back to in-memory if Redis unavailable).
 * Use this as the global API rate limit. Per-endpoint limits should use authRateLimit.
 *
 * @param windowMs - Window size in milliseconds (default 60s)
 * @param max - Max requests per window per IP (default 100)
 */
export function rateLimiter(windowMs = 60000, max = 100) {
  const windowSeconds = Math.ceil(windowMs / 1000);
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `global:${req.ip || 'unknown'}`;
    try {
      const result = await checkRateLimit(key, max, windowSeconds);

      // Add rate limit headers for client visibility
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

      if (!result.allowed) {
        return next(new TooManyRequestsError());
      }
      next();
    } catch (err) {
      // Fail open on unexpected errors so the API doesn't go down
      next();
    }
  };
}
