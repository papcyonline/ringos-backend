import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config/env', () => ({ env: { JWT_SECRET: 'secret-x' } }));
const { jwtVerify } = vi.hoisted(() => ({ jwtVerify: vi.fn() }));

vi.mock('jsonwebtoken', () => ({
  default: { verify: jwtVerify },
  verify: jwtVerify,
}));

import { requireAdmin } from '../admin.middleware';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(headers: Record<string, string> = {}) {
  return { headers, admin: undefined } as any;
}

describe('admin.middleware', () => {
  it('rejects when no Authorization header', () => {
    const next = vi.fn();
    requireAdmin(makeReq(), {} as any, next);
    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Missing/);
  });

  it('rejects when not Bearer scheme', () => {
    const next = vi.fn();
    requireAdmin(makeReq({ authorization: 'Basic abc' }), {} as any, next);
    expect(next.mock.calls[0][0].message).toMatch(/Missing/);
  });

  it('rejects when payload is wrong kind', () => {
    jwtVerify.mockReturnValue({ kind: 'user', adminId: 'a-1' });
    const next = vi.fn();
    requireAdmin(makeReq({ authorization: 'Bearer x' }), {} as any, next);
    expect(next.mock.calls[0][0].message).toMatch(/Not an admin/);
  });

  it('rejects when no adminId', () => {
    jwtVerify.mockReturnValue({ kind: 'admin' });
    const next = vi.fn();
    requireAdmin(makeReq({ authorization: 'Bearer x' }), {} as any, next);
    expect(next.mock.calls[0][0].message).toMatch(/Not an admin/);
  });

  it('attaches admin payload and calls next on success', () => {
    jwtVerify.mockReturnValue({ kind: 'admin', adminId: 'a-1', role: 'OWNER' });
    const next = vi.fn();
    const req = makeReq({ authorization: 'Bearer x' });
    requireAdmin(req, {} as any, next);
    expect(req.admin).toEqual({ kind: 'admin', adminId: 'a-1', role: 'OWNER' });
    expect(next).toHaveBeenCalledWith();
  });

  it('passes a friendlier message when token expired', () => {
    const err: any = new Error('expired');
    err.name = 'TokenExpiredError';
    jwtVerify.mockImplementation(() => { throw err; });
    const next = vi.fn();
    requireAdmin(makeReq({ authorization: 'Bearer x' }), {} as any, next);
    expect(next.mock.calls[0][0].message).toMatch(/expired/i);
  });

  it('passes through other jwt errors', () => {
    const err: any = new Error('bad sig');
    err.name = 'JsonWebTokenError';
    jwtVerify.mockImplementation(() => { throw err; });
    const next = vi.fn();
    requireAdmin(makeReq({ authorization: 'Bearer x' }), {} as any, next);
    expect(next.mock.calls[0][0]).toBe(err);
  });
});
