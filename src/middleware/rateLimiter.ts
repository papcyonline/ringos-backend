import { Request, Response, NextFunction } from 'express';
import { TooManyRequestsError } from '../shared/errors';

const requests = new Map<string, { count: number; resetAt: number }>();

export function rateLimiter(windowMs = 60000, max = 100) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = requests.get(key);

    if (!entry || now > entry.resetAt) {
      requests.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      return next(new TooManyRequestsError());
    }

    next();
  };
}

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requests) {
    if (now > entry.resetAt) requests.delete(key);
  }
}, 60000);
