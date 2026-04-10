import { Response, NextFunction } from 'express';
import { AuthRequest } from '../shared/types';
import { checkRateLimit } from '../shared/redis.service';

/**
 * Per-user rate limiting for authenticated endpoints (spam prevention).
 * Falls back to IP-based limiting if the request is unauthenticated.
 *
 * Use this for content-creation endpoints like posts, comments, messages.
 */
export function userRateLimit(key: string, maxAttempts: number, windowSeconds: number) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.userId;
    const identifier = userId || req.ip || req.socket.remoteAddress || 'unknown';
    const result = await checkRateLimit(`user:${key}:${identifier}`, maxAttempts, windowSeconds);
    if (!result.allowed) {
      res.status(429).json({
        error: { message: 'You are doing that too often. Please slow down.', code: 'RATE_LIMITED' },
      });
      return;
    }
    next();
  };
}
