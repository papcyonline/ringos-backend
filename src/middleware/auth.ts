import { Response, NextFunction } from 'express';
import { UnauthorizedError } from '../shared/errors';
import { AuthRequest } from '../shared/types';
import { verifyAccessToken } from '../modules/auth/auth.utils';
import { isAccessTokenRevoked } from '../modules/auth/token-revocation';

export async function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }
    const token = header.slice(7);
    const payload = verifyAccessToken(token);
    // Reject access tokens issued before a logout-all / compromise revocation.
    if (await isAccessTokenRevoked(payload.userId, payload.iat)) {
      throw new UnauthorizedError('Session has been revoked. Please log in again.');
    }
    req.user = payload;
    next();
  } catch {
    next(new UnauthorizedError());
  }
}
