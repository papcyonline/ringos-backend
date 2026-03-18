import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../shared/redis.service';

/**
 * Per-route rate limiting middleware.
 * Uses Redis if available, falls back to in-memory.
 */
export function authRateLimit(key: string, maxAttempts: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const result = await checkRateLimit(`auth:${key}:${ip}`, maxAttempts, windowSeconds);
    if (!result.allowed) {
      res.status(429).json({ message: 'Too many attempts, try again later' });
      return;
    }
    next();
  };
}
