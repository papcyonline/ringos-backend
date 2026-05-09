import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockServerCtor,
  mockCreateClient,
  mockCreateAdapter,
  mockVerifyAccessToken,
  mockSetOnline,
  mockSetOffline,
  mockCheckBanStatus,
  mockPrisma,
} = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  const mockServerInstance: any = new EventEmitter();
  mockServerInstance.use = vi.fn();
  mockServerInstance.adapter = vi.fn();
  mockServerInstance.in = vi.fn(() => ({
    fetchSockets: vi.fn().mockResolvedValue([]),
  }));
  mockServerInstance.emit = vi.fn();

  const mockServerCtor = vi.fn(() => mockServerInstance);
  (mockServerCtor as any).instance = mockServerInstance;
  return {
    mockServerCtor,
    mockCreateClient: vi.fn(),
    mockCreateAdapter: vi.fn(() => ({})),
    mockVerifyAccessToken: vi.fn(),
    mockSetOnline: vi.fn().mockResolvedValue(undefined),
    mockSetOffline: vi.fn().mockResolvedValue(undefined),
    mockCheckBanStatus: vi.fn().mockResolvedValue({ banned: false }),
    mockPrisma: { user: { findUnique: vi.fn().mockResolvedValue({ hideOnlineStatus: false }) } },
  };
});

vi.mock('socket.io', () => ({ Server: mockServerCtor }));
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: mockCreateAdapter }));
vi.mock('redis', () => ({ createClient: mockCreateClient }));
vi.mock('../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../modules/auth/auth.utils', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));
vi.mock('../../modules/user/user.service', () => ({
  setOnline: mockSetOnline,
  setOffline: mockSetOffline,
}));
vi.mock('../../modules/safety/safety.service', () => ({
  checkBanStatus: mockCheckBanStatus,
}));
vi.mock('../database', () => ({ prisma: mockPrisma }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe('socket.ts', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({
      env: { CORS_ORIGIN: '*', REDIS_URL: '' },
    }));
  });

  it('getIO throws before init', async () => {
    const mod = await import('../socket');
    expect(() => mod.getIO()).toThrow(/not initialized/);
  });

  it('initializeSocket creates Server and registers middleware', async () => {
    const mod = await import('../socket');
    const httpServer: any = {};
    const io = await mod.initializeSocket(httpServer);
    expect(mockServerCtor).toHaveBeenCalled();
    expect((io as any).use).toHaveBeenCalled();
  });

  it('isUserForeground returns false when no foreground sockets', async () => {
    const mod = await import('../socket');
    await mod.initializeSocket({} as any);
    const res = await mod.isUserForeground('u-1');
    expect(res).toBe(false);
  });

  it('isUserForeground returns true when foreground sockets exist', async () => {
    const ioInstance = (mockServerCtor as any).instance;
    ioInstance.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([{}]) }));
    const mod = await import('../socket');
    await mod.initializeSocket({} as any);
    const res = await mod.isUserForeground('u-1');
    expect(res).toBe(true);
  });

  it('isUserForeground returns false before init', async () => {
    const mod = await import('../socket');
    const res = await mod.isUserForeground('u-1');
    expect(res).toBe(false);
  });
});

describe('socket.ts auth middleware + connection', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({
      env: { CORS_ORIGIN: '*', REDIS_URL: '' },
    }));
  });

  it('auth middleware rejects when no token', async () => {
    const mod = await import('../socket');
    const io = await mod.initializeSocket({} as any);
    const useCalls = (io as any).use.mock.calls;
    const middleware = useCalls[0][0];
    const next = vi.fn();
    await middleware({ handshake: { auth: {}, headers: {} } } as any, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('auth middleware rejects on invalid token', async () => {
    mockVerifyAccessToken.mockImplementation(() => { throw new Error('bad'); });
    const mod = await import('../socket');
    const io = await mod.initializeSocket({} as any);
    const middleware = (io as any).use.mock.calls[0][0];
    const next = vi.fn();
    await middleware({ handshake: { auth: { token: 'x' }, headers: {} } } as any, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('auth middleware accepts valid token and sets userId', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: 'u-1' });
    mockCheckBanStatus.mockResolvedValueOnce({ banned: false });
    const mod = await import('../socket');
    const io = await mod.initializeSocket({} as any);
    const middleware = (io as any).use.mock.calls[0][0];
    const socket: any = { handshake: { auth: { token: 'x' }, headers: {} } };
    const next = vi.fn();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(socket.userId).toBe('u-1');
  });

  it('auth middleware rejects banned user', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: 'u-1' });
    mockCheckBanStatus.mockResolvedValueOnce({ banned: true });
    const mod = await import('../socket');
    const io = await mod.initializeSocket({} as any);
    const middleware = (io as any).use.mock.calls[0][0];
    const next = vi.fn();
    await middleware({ handshake: { auth: { token: 'x' }, headers: {} } } as any, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('suspended') }));
  });

  it('auth middleware uses authorization header as fallback', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: 'u-1' });
    mockCheckBanStatus.mockResolvedValueOnce({ banned: false });
    const mod = await import('../socket');
    const io = await mod.initializeSocket({} as any);
    const middleware = (io as any).use.mock.calls[0][0];
    const socket: any = { handshake: { auth: {}, headers: { authorization: 'Bearer abc' } } };
    const next = vi.fn();
    await middleware(socket, next);
    expect(mockVerifyAccessToken).toHaveBeenCalledWith('abc');
  });
});

describe('socket.ts with Redis', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({
      env: { CORS_ORIGIN: 'https://a.com,https://b.com', REDIS_URL: 'redis://x' },
    }));
  });

  it('connects Redis adapter when REDIS_URL configured', async () => {
    const fakeClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      duplicate: vi.fn(),
    };
    fakeClient.duplicate.mockReturnValue(fakeClient);
    mockCreateClient.mockReturnValue(fakeClient);

    const mod = await import('../socket');
    await mod.initializeSocket({} as any);
    expect(mockCreateClient).toHaveBeenCalled();
    expect(fakeClient.connect).toHaveBeenCalled();
  });

  it('falls back to in-memory when Redis fails', async () => {
    const fakeClient = {
      connect: vi.fn().mockRejectedValue(new Error('redis-down')),
      disconnect: vi.fn().mockResolvedValue(undefined),
      duplicate: vi.fn(),
    };
    fakeClient.duplicate.mockReturnValue(fakeClient);
    mockCreateClient.mockReturnValue(fakeClient);

    const mod = await import('../socket');
    await mod.initializeSocket({} as any);
    // No throw
  });
});
