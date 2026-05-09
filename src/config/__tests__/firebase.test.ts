import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockInitializeApp, mockCert } = vi.hoisted(() => ({
  mockInitializeApp: vi.fn(),
  mockCert: vi.fn((opts: any) => ({ cert: opts })),
}));

vi.mock('firebase-admin', () => ({
  initializeApp: mockInitializeApp,
  credential: { cert: mockCert },
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

describe('firebase init (configured)', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({
      env: {
        FIREBASE_PROJECT_ID: 'p-1',
        FIREBASE_CLIENT_EMAIL: 'svc@x.com',
        FIREBASE_PRIVATE_KEY: 'a\\nb\\nc',
      },
    }));
  });

  it('initializes once and returns same app', async () => {
    mockInitializeApp.mockReturnValueOnce({ name: 'app-1' } as any);
    const mod = await import('../firebase');
    const app1 = mod.initializeFirebase();
    const app2 = mod.initializeFirebase();
    expect(app1).toBeDefined();
    expect(app2).toBe(app1);
    // \n's in private key get replaced
    expect(mockCert).toHaveBeenCalledWith(expect.objectContaining({
      privateKey: 'a\nb\nc',
    }));
  });

  it('returns null on init error', async () => {
    mockInitializeApp.mockImplementationOnce(() => { throw new Error('init failed'); });
    const mod = await import('../firebase');
    const app = mod.initializeFirebase();
    expect(app).toBeNull();
  });

  it('getFirebaseApp returns null before init', async () => {
    const mod = await import('../firebase');
    expect(mod.getFirebaseApp()).toBeNull();
  });

  it('getFirebaseApp returns app after init', async () => {
    mockInitializeApp.mockReturnValueOnce({ name: 'app-1' } as any);
    const mod = await import('../firebase');
    mod.initializeFirebase();
    expect(mod.getFirebaseApp()).toBeDefined();
  });
});

describe('firebase init (not configured)', () => {
  beforeEach(() => {
    vi.doMock('../env', () => ({ env: {} }));
  });

  it('returns null when missing env', async () => {
    const mod = await import('../firebase');
    const app = mod.initializeFirebase();
    expect(app).toBeNull();
  });
});
