import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock auth.utils ─────────────────────────────────────────────────
vi.mock('../../modules/auth/auth.utils', () => ({
  verifyAccessToken: vi.fn(),
}));

// Revocation check is exercised in its own unit; here it should be a no-op
// (no token revoked) so the middleware's core behaviour is what's under test.
vi.mock('../../modules/auth/token-revocation', () => ({
  isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
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

  it('should populate req.user and call next() with a valid Bearer token', async () => {
    const payload = { userId: 'user-1', isAnonymous: false };
    (verifyAccessToken as any).mockReturnValue(payload);

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer valid-token' });
    await authenticate(req, res, next);

    expect(verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual(payload);
    expect(next).toHaveBeenCalledWith();
  });

  it('should call next with UnauthorizedError when Authorization header is missing', async () => {
    const { req, res, next } = mockReqResNext({});
    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should call next with UnauthorizedError when header does not start with "Bearer "', async () => {
    const { req, res, next } = mockReqResNext({ authorization: 'Basic abc123' });
    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should call next with UnauthorizedError when header is just "Bearer" (no token)', async () => {
    const { req, res, next } = mockReqResNext({ authorization: 'Bearer' });
    await authenticate(req, res, next);

    // "Bearer" does not start with "Bearer " (with space), so it triggers error
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should call next with UnauthorizedError when verifyAccessToken throws', async () => {
    (verifyAccessToken as any).mockImplementation(() => {
      throw new Error('Invalid token');
    });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer expired-token' });
    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should not set req.user when token is invalid', async () => {
    (verifyAccessToken as any).mockImplementation(() => {
      throw new Error('jwt malformed');
    });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer bad-token' });
    await authenticate(req, res, next);

    expect(req.user).toBeUndefined();
  });

  it('should correctly extract token from "Bearer <token>"', async () => {
    const payload = { userId: 'user-2', isAnonymous: true };
    (verifyAccessToken as any).mockReturnValue(payload);

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer my-jwt-token-here' });
    await authenticate(req, res, next);

    expect(verifyAccessToken).toHaveBeenCalledWith('my-jwt-token-here');
  });

  it('should set isAnonymous from the token payload', async () => {
    const payload = { userId: 'anon-1', isAnonymous: true };
    (verifyAccessToken as any).mockReturnValue(payload);

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer token' });
    await authenticate(req, res, next);

    expect(req.user.isAnonymous).toBe(true);
  });

  it('should call next exactly once on success', async () => {
    (verifyAccessToken as any).mockReturnValue({ userId: 'user-1', isAnonymous: false });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer token' });
    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should call next exactly once on failure', async () => {
    const { req, res, next } = mockReqResNext({});
    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should reject a token that has been revoked', async () => {
    const { isAccessTokenRevoked } = await import('../../modules/auth/token-revocation');
    (isAccessTokenRevoked as any).mockResolvedValueOnce(true);
    (verifyAccessToken as any).mockReturnValue({ userId: 'user-1', isAnonymous: false, iat: 1000 });

    const { req, res, next } = mockReqResNext({ authorization: 'Bearer token' });
    await authenticate(req, res, next);

    expect(req.user).toBeUndefined();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});
