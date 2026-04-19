import { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AuthRequest } from '../../shared/types';
import { ForbiddenError } from '../../shared/errors';
import { AdminTokenPayload } from './admin.service';

/**
 * Verifies the caller presents a valid admin JWT (kind === 'admin').
 * Puts the admin payload on `req` for downstream handlers.
 */
export function requireAdmin(
  req: AuthRequest & { admin?: AdminTokenPayload },
  _res: Response,
  next: NextFunction,
) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new ForbiddenError('Missing admin token');
    }
    const token = header.slice('Bearer '.length);
    const payload = jwt.verify(token, env.JWT_SECRET) as AdminTokenPayload;
    if (payload.kind !== 'admin' || !payload.adminId) {
      throw new ForbiddenError('Not an admin token');
    }
    req.admin = payload;
    next();
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      next(new ForbiddenError('Admin token expired — please log in again'));
    } else {
      next(err);
    }
  }
}
