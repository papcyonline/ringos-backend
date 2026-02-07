import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock auth.utils ─────────────────────────────────────────────────
vi.mock('../../modules/auth/auth.utils', () => ({
  verifyAccessToken: vi.fn(),
}));

import { authenticate } from '../auth';
import { verifyAccessToken } from '../../modules/auth/auth.utils';
import { UnauthorizedError } from '../../shared/errors';

// ── Helpers ─────────────────────────────────────────────────────────

function mockReqResNext(headers: Record<string, string> = {}) {
  const req: any = {
    headers,
    user: undefined,
  };
  const res: any = {};
  const next = vi.fn();
  return { req, res, next };
}

describe('authenticate middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should populate req.user and call next() with a valid Bearer token', () => {
    const payload = { userId: 'user-1', isAnonymous: false };
    (verifyAccessToken as any).mockReturnValue(payload);

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer valid-token' });
    authenticate(req, res, next);

    expect(verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual(payload);
    expect(next).toHaveBeenCalledWith();
  });

  it('should call next with UnauthorizedError when Authorization header is missing', () => {
    const { req, res, next } = mockReqResNext({});
    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should call next with UnauthorizedError when header does not start with "Bearer "', () => {
    const { req, res, next } = mockReqResNext({ authorization: 'Basic abc123' });
    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should call next with UnauthorizedError when header is just "Bearer" (no token)', () => {
    const { req, res, next } = mockReqResNext({ authorization: 'Bearer' });
    authenticate(req, res, next);

    // "Bearer" does not start with "Bearer " (with space), so it triggers error
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should call next with UnauthorizedError when verifyAccessToken throws', () => {
    (verifyAccessToken as any).mockImplementation(() => {
      throw new Error('Invalid token');
    });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer expired-token' });
    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should not set req.user when token is invalid', () => {
    (verifyAccessToken as any).mockImplementation(() => {
      throw new Error('jwt malformed');
    });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer bad-token' });
    authenticate(req, res, next);

    expect(req.user).toBeUndefined();
  });

  it('should correctly extract token from "Bearer <token>"', () => {
    const payload = { userId: 'user-2', isAnonymous: true };
    (verifyAccessToken as any).mockReturnValue(payload);

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer my-jwt-token-here' });
    authenticate(req, res, next);

    expect(verifyAccessToken).toHaveBeenCalledWith('my-jwt-token-here');
  });

  it('should set isAnonymous from the token payload', () => {
    const payload = { userId: 'anon-1', isAnonymous: true };
    (verifyAccessToken as any).mockReturnValue(payload);

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer token' });
    authenticate(req, res, next);

    expect(req.user.isAnonymous).toBe(true);
  });

  it('should call next exactly once on success', () => {
    (verifyAccessToken as any).mockReturnValue({ userId: 'user-1', isAnonymous: false });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer token' });
    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should call next exactly once on failure', () => {
    const { req, res, next } = mockReqResNext({});
    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
