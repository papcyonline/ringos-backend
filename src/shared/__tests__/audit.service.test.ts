import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockLoggerError } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({}),
  mockLoggerError: vi.fn(),
}));

vi.mock('../../config/database', () => ({
  prisma: { securityAuditLog: { create: mockCreate } },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError, debug: vi.fn() },
}));

import { logSecurityEvent } from '../audit.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('audit.service', () => {
  it('persists event with userId, ip and user-agent from req', async () => {
    const req: any = {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest', 'x-forwarded-for': '10.0.0.1' },
    };
    logSecurityEvent({ userId: 'u-1', event: 'LOGIN_SUCCESS', req, metadata: { x: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u-1',
        event: 'LOGIN_SUCCESS',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        metadata: { x: 1 },
      }),
    });
  });

  it('falls back to x-forwarded-for when ip absent', () => {
    const req: any = {
      headers: { 'user-agent': 'ua', 'x-forwarded-for': '10.0.0.1' },
    };
    logSecurityEvent({ event: 'LOGIN_FAILED', req });
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ipAddress: '10.0.0.1',
        userId: null,
      }),
    });
  });

  it('handles missing req gracefully', () => {
    logSecurityEvent({ event: 'SESSION_REVOKED', userId: 'u-1' });
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ipAddress: null,
        userAgent: null,
        userId: 'u-1',
      }),
    });
  });

  it('logs error when create rejects', async () => {
    mockCreate.mockRejectedValueOnce(new Error('db fail'));
    logSecurityEvent({ event: 'LOGIN_LOCKED' });
    await new Promise((r) => setImmediate(r));
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
