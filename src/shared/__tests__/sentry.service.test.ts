import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSentry } = vi.hoisted(() => {
  const scope = { setExtras: vi.fn(), setLevel: vi.fn() };
  const mockSentry: any = {
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
    startInactiveSpan: vi.fn(() => ({ end: vi.fn() })),
    flush: vi.fn().mockResolvedValue(true),
    expressErrorHandler: vi.fn(() => (_err: any, _req: any, _res: any, next: any) => next()),
    captureConsoleIntegration: vi.fn(() => ({})),
    withScope: vi.fn((fn: any) => fn(scope)),
    _scope: scope,
  };
  return { mockSentry };
});

vi.mock('@sentry/node', () => mockSentry);
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe('sentry.service (configured)', () => {
  beforeEach(() => {
    vi.doMock('../../config/env', () => ({
      env: { SENTRY_DSN: 'https://x@sentry.io/1', NODE_ENV: 'production' },
    }));
  });

  it('initSentry calls Sentry.init', async () => {
    const mod = await import('../sentry.service');
    mod.initSentry();
    expect(mockSentry.init).toHaveBeenCalled();
  });

  it('beforeSend filters auth header and password fields (object body)', async () => {
    const mod = await import('../sentry.service');
    mod.initSentry();
    const config = mockSentry.init.mock.calls[0][0];
    const event = {
      request: {
        headers: { authorization: 'Bearer x', cookie: 'c', other: 'ok' },
        data: { password: 'pw', token: 't', refreshToken: 'r', idToken: 'i', name: 'a' },
      },
    };
    const result = config.beforeSend(event);
    expect(result.request.headers.authorization).toBeUndefined();
    expect(result.request.headers.cookie).toBeUndefined();
    const data = JSON.parse(result.request.data);
    expect(data.password).toBe('[FILTERED]');
    expect(data.token).toBe('[FILTERED]');
    expect(data.refreshToken).toBe('[FILTERED]');
    expect(data.idToken).toBe('[FILTERED]');
    expect(data.name).toBe('a');
  });

  it('beforeSend handles string body', async () => {
    const mod = await import('../sentry.service');
    mod.initSentry();
    const config = mockSentry.init.mock.calls[0][0];
    const event = {
      request: { data: '{"password":"pw"}' },
    };
    const result = config.beforeSend(event);
    expect(result.request.data).toContain('[FILTERED]');
  });

  it('captureException with context', async () => {
    const mod = await import('../sentry.service');
    mod.captureException(new Error('boom'), { x: 1 });
    expect(mockSentry.captureException).toHaveBeenCalled();
    expect(mockSentry._scope.setExtras).toHaveBeenCalledWith({ x: 1 });
  });

  it('captureMessage with level', async () => {
    const mod = await import('../sentry.service');
    mod.captureMessage('hi', 'warning', { x: 1 });
    expect(mockSentry.captureMessage).toHaveBeenCalledWith('hi');
    expect(mockSentry._scope.setLevel).toHaveBeenCalledWith('warning');
  });

  it('setUser delegates', async () => {
    const mod = await import('../sentry.service');
    mod.setUser({ id: 'u-1', email: 'a@b.com' });
    expect(mockSentry.setUser).toHaveBeenCalled();
  });

  it('addBreadcrumb delegates', async () => {
    const mod = await import('../sentry.service');
    mod.addBreadcrumb('cat', 'msg', { x: 1 }, 'info');
    expect(mockSentry.addBreadcrumb).toHaveBeenCalled();
  });

  it('startTransaction returns a span', async () => {
    const mod = await import('../sentry.service');
    const span = mod.startTransaction('t', 'op');
    expect(span).toBeDefined();
  });

  it('flush invokes Sentry.flush', async () => {
    const mod = await import('../sentry.service');
    const ok = await mod.flush();
    expect(ok).toBe(true);
  });

  it('isSentryConfigured exports flag', async () => {
    const mod = await import('../sentry.service');
    expect(mod.isSentryConfigured).toBe(true);
  });

  it('sentryRequestHandler calls next', async () => {
    const mod = await import('../sentry.service');
    const next = vi.fn();
    mod.sentryRequestHandler({} as any, {} as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('sentryErrorHandler is a function', async () => {
    const mod = await import('../sentry.service');
    expect(typeof mod.sentryErrorHandler).toBe('function');
  });
});

describe('sentry.service (not configured)', () => {
  beforeEach(() => {
    vi.doMock('../../config/env', () => ({ env: { SENTRY_DSN: '', NODE_ENV: 'test' } }));
  });

  it('initSentry early-returns', async () => {
    const mod = await import('../sentry.service');
    mod.initSentry();
    expect(mockSentry.init).not.toHaveBeenCalled();
  });

  it('captureException is no-op', async () => {
    const mod = await import('../sentry.service');
    mod.captureException(new Error('x'));
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it('captureMessage is no-op', async () => {
    const mod = await import('../sentry.service');
    mod.captureMessage('x');
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  it('setUser is no-op', async () => {
    const mod = await import('../sentry.service');
    mod.setUser({ id: 'u-1' });
    expect(mockSentry.setUser).not.toHaveBeenCalled();
  });

  it('addBreadcrumb is no-op', async () => {
    const mod = await import('../sentry.service');
    mod.addBreadcrumb('c', 'm');
    expect(mockSentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('startTransaction returns undefined', async () => {
    const mod = await import('../sentry.service');
    expect(mod.startTransaction('t', 'o')).toBeUndefined();
  });

  it('flush returns true without calling Sentry.flush', async () => {
    const mod = await import('../sentry.service');
    const ok = await mod.flush();
    expect(ok).toBe(true);
    expect(mockSentry.flush).not.toHaveBeenCalled();
  });
});
