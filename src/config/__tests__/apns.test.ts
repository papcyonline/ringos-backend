import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockHttp2Connect, mockCreatePrivateKey, mockCreateSign } = vi.hoisted(() => ({
  mockHttp2Connect: vi.fn(),
  mockCreatePrivateKey: vi.fn(),
  mockCreateSign: vi.fn(),
}));

vi.mock('http2', () => ({
  connect: mockHttp2Connect,
}));

vi.mock('crypto', () => ({
  createPrivateKey: mockCreatePrivateKey,
  createSign: mockCreateSign,
}));

vi.mock('../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

function makeFakeRequest(statusCode: number, responseBody = '', triggerError = false) {
  const req = new EventEmitter() as any;
  req.setEncoding = vi.fn();
  req.end = vi.fn(() => {
    setImmediate(() => {
      if (triggerError) {
        req.emit('error', new Error('connection reset'));
        return;
      }
      req.emit('response', { ':status': statusCode });
      if (responseBody) req.emit('data', responseBody);
      req.emit('end');
    });
  });
  return req;
}

function makeFakeSession() {
  const sess = new EventEmitter() as any;
  sess.closed = false;
  sess.destroyed = false;
  sess.close = vi.fn();
  sess.request = vi.fn();
  return sess;
}

describe('apns (configured)', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({
      env: {
        APNS_KEY_ID: 'key',
        APNS_TEAM_ID: 'team',
        APNS_KEY: Buffer.from('-----BEGIN-----\n-----END-----').toString('base64'),
        APNS_PRODUCTION: false,
      },
    }));

    // crypto stubs for JWT signing
    mockCreatePrivateKey.mockReturnValue({} as any);
    mockCreateSign.mockReturnValue({
      update: vi.fn(),
      sign: vi.fn(() => Buffer.from('sig')),
    } as any);
  });

  it('returns success on 200 response', async () => {
    const sess = makeFakeSession();
    sess.request.mockReturnValue(makeFakeRequest(200, ''));
    mockHttp2Connect.mockReturnValue(sess);

    const mod = await import('../apns');
    const res = await mod.sendVoipPush('tok', { foo: 'bar' });
    expect(res.success).toBe(true);
  });

  it('returns unregistered=true on 410', async () => {
    const sess = makeFakeSession();
    sess.request.mockReturnValue(makeFakeRequest(410, '410 unregistered'));
    mockHttp2Connect.mockReturnValue(sess);

    const mod = await import('../apns');
    const res = await mod.sendVoipPush('tok', {});
    expect(res.success).toBe(false);
    expect(res.unregistered).toBe(true);
  });

  it('returns success=false on 403 (invalid auth)', async () => {
    const sess = makeFakeSession();
    sess.request.mockReturnValue(makeFakeRequest(403, 'InvalidProviderToken'));
    mockHttp2Connect.mockReturnValue(sess);

    const mod = await import('../apns');
    const res = await mod.sendVoipPush('tok', {});
    expect(res.success).toBe(false);
  });

  it('retries on connection error', async () => {
    const sess = makeFakeSession();
    let calls = 0;
    sess.request.mockImplementation(() => {
      calls++;
      if (calls === 1) return makeFakeRequest(0, '', true);
      return makeFakeRequest(200);
    });
    mockHttp2Connect.mockReturnValue(sess);

    const mod = await import('../apns');
    const res = await mod.sendVoipPush('tok', {});
    expect(res.success).toBe(true);
    expect(calls).toBe(2);
  });

  it('retries on alt environment for BadDeviceToken', async () => {
    const sess1 = makeFakeSession();
    sess1.request.mockReturnValue(makeFakeRequest(400, 'BadDeviceToken'));

    const sess2 = makeFakeSession();
    sess2.request.mockReturnValue(makeFakeRequest(200));

    let connectCount = 0;
    mockHttp2Connect.mockImplementation(() => {
      connectCount++;
      return connectCount === 1 ? sess1 : sess2;
    });

    const mod = await import('../apns');
    const res = await mod.sendVoipPush('tok', {});
    expect(res.success).toBe(true);
  });

  it('caches JWT across calls within validity window', async () => {
    const sess = makeFakeSession();
    sess.request.mockReturnValue(makeFakeRequest(200));
    mockHttp2Connect.mockReturnValue(sess);

    const mod = await import('../apns');
    await mod.sendVoipPush('tok', {});
    await mod.sendVoipPush('tok', {});
    // createPrivateKey should only be called once thanks to caching
    expect(mockCreatePrivateKey).toHaveBeenCalledTimes(1);
  });
});

describe('apns (not configured)', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({
      env: { APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_KEY: '' },
    }));
  });

  it('returns success=false without making request', async () => {
    const mod = await import('../apns');
    const res = await mod.sendVoipPush('tok', {});
    expect(res.success).toBe(false);
    expect(mockHttp2Connect).not.toHaveBeenCalled();
  });
});
