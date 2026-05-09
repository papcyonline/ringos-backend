import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('../../shared/redis.service', () => ({
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { errorHandler } from '../errorHandler';
import { rateLimiter } from '../rateLimiter';
import { authRateLimit } from '../authRateLimit';
import { userRateLimit } from '../userRateLimit';
import { AppError } from '../../shared/errors';
import { ZodError } from 'zod';
import { MulterError } from 'multer';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

describe('errorHandler', () => {
  it('handles AppError', () => {
    const res = makeRes();
    const err = new AppError(403, 'no', 'BAD');
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'no', code: 'BAD' } });
  });

  it('handles ZodError', () => {
    const res = makeRes();
    const err = new ZodError([
      { code: 'invalid_type', expected: 'string', received: 'number', path: ['name'], message: 'Bad' } as any,
    ]);
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const arg = (res.json as any).mock.calls[0][0];
    expect(arg.error.code).toBe('VALIDATION_ERROR');
    expect(arg.error.details[0].path).toBe('name');
  });

  it('handles MulterError LIMIT_FILE_SIZE', () => {
    const res = makeRes();
    const err: any = new MulterError('LIMIT_FILE_SIZE');
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect((res.json as any).mock.calls[0][0].error.message).toBe('File is too large');
  });

  it('handles MulterError LIMIT_UNEXPECTED_FILE', () => {
    const res = makeRes();
    const err: any = new MulterError('LIMIT_UNEXPECTED_FILE');
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect((res.json as any).mock.calls[0][0].error.message).toBe('Unexpected file in upload');
  });

  it('handles MulterError fallback', () => {
    const res = makeRes();
    const err: any = new MulterError('LIMIT_FIELD_VALUE' as any);
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
  });

  it('handles "Only ..." messages as 415', () => {
    const res = makeRes();
    const err = new Error('Only image files allowed');
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(415);
  });

  it('handles "Unsupported file" messages as 415', () => {
    const res = makeRes();
    const err = new Error('Unsupported file type');
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(415);
  });

  it('falls back to 500', () => {
    const res = makeRes();
    const err = new Error('mystery');
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('rateLimiter', () => {
  it('passes through and sets headers when allowed', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5, resetAt: 1000000 });
    const next = vi.fn();
    const res = makeRes();
    await rateLimiter(60000, 10)({ ip: '1.1.1.1' } as any, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 429-style error when limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1000000 });
    const next = vi.fn();
    const res = makeRes();
    await rateLimiter(60000, 10)({ ip: '1.1.1.1' } as any, res, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect((err as any).statusCode).toBe(429);
  });

  it('fails open on redis errors', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis-down'));
    const next = vi.fn();
    await rateLimiter()({ ip: '1.1.1.1' } as any, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('authRateLimit', () => {
  it('allows when within limit', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5, resetAt: 1000000 });
    const next = vi.fn();
    await authRateLimit('login', 5, 60)({ ip: '1.1.1.1', socket: {} } as any, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 429 when exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1000000 });
    const next = vi.fn();
    const res = makeRes();
    await authRateLimit('login', 5, 60)({ ip: '1.1.1.1', socket: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to socket address when no ip', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5, resetAt: 1000 });
    const next = vi.fn();
    await authRateLimit('login', 5, 60)({ socket: { remoteAddress: '2.2.2.2' } } as any, makeRes(), next);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.stringContaining('2.2.2.2'), 5, 60);
  });
});

describe('userRateLimit', () => {
  it('allows when within limit', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5, resetAt: 1000000 });
    const next = vi.fn();
    await userRateLimit('post', 5, 60)({ user: { userId: 'u-1' }, ip: '1.1.1.1', socket: {} } as any, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 429 when exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1000000 });
    const next = vi.fn();
    const res = makeRes();
    await userRateLimit('post', 5, 60)({ user: { userId: 'u-1' }, ip: '1.1.1.1', socket: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('uses ip when unauthenticated', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5, resetAt: 1000 });
    const next = vi.fn();
    await userRateLimit('post', 5, 60)({ ip: '3.3.3.3', socket: {} } as any, makeRes(), next);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.stringContaining('3.3.3.3'), 5, 60);
  });
});
