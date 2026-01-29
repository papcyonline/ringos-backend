import { Response, NextFunction } from 'express';
import { UnauthorizedError } from '../shared/errors';
import { AuthRequest } from '../shared/types';
import { verifyAccessToken } from '../modules/auth/auth.utils';

export function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }
    const token = header.slice(7);
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch {
    next(new UnauthorizedError());
  }
}
