import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock all upstream deps before the router imports them.
vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({
  env: {
    GOOGLE_CLIENT_ID_WEB: '',
    GOOGLE_CLIENT_ID_IOS: '',
    GOOGLE_CLIENT_ID_ANDROID: '',
    APPLE_CLIENT_ID: 'com.yomeet.app',
  },
}));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../middleware/validate', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../../../middleware/authRateLimit', () => ({
  authRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../shared/upload', () => ({
  avatarUpload: {
    single: () => (req: any, _res: any, next: any) => {
      req.file = req.body?._mockFile;
      next();
    },
  },
  fileToAvatarUrl: vi.fn().mockResolvedValue('https://cdn/avatar.jpg'),
}));
vi.mock('../auth.schema', () => ({
  anonymousAuthSchema: {},
  registerSchema: {},
  loginSchema: {},
  usernameSchema: { parse: (b: any) => b },
  phoneAuthSchema: {},
  verifyOtpSchema: {},
  refreshTokenSchema: {},
  forgotPasswordSchema: {},
  resetPasswordSchema: {},
  googleAuthSchema: {},
  appleAuthSchema: {},
  emailOtpSchema: {},
  resendOtpSchema: {},
}));

const { mockAuthService, mockTwoFactor } = vi.hoisted(() => ({
  mockAuthService: {
    register: vi.fn().mockResolvedValue({ message: 'OTP sent', userId: 'u-1' }),
    verifyEmailOtp: vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1', displayName: 'A', isAnonymous: true },
    }),
    resendEmailOtp: vi.fn().mockResolvedValue({ message: 'OTP resent' }),
    login: vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1', displayName: 'A', isAnonymous: false },
    }),
    googleAuth: vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1', displayName: 'A', isAnonymous: false }, isNewUser: false,
    }),
    appleAuth: vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1', displayName: 'A', isAnonymous: false }, isNewUser: true,
    }),
    checkUsernameAvailable: vi.fn().mockResolvedValue(true),
    setUsername: vi.fn().mockResolvedValue({ displayName: 'Alice', avatarUrl: null }),
    anonymousLogin: vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1', displayName: 'Anon', isAnonymous: true },
    }),
    requestOtp: vi.fn().mockResolvedValue({ message: 'OTP sent' }),
    verifyOtp: vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1', displayName: 'A', isAnonymous: true },
    }),
    refreshTokens: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    requestPasswordReset: vi.fn().mockResolvedValue({ message: 'sent' }),
    resetPassword: vi.fn().mockResolvedValue({ message: 'reset' }),
    logout: vi.fn().mockResolvedValue({ message: 'ok' }),
    logoutAll: vi.fn().mockResolvedValue({ message: 'ok', sessionsRevoked: 1 }),
    getUserSessions: vi.fn().mockResolvedValue([]),
    revokeSession: vi.fn().mockResolvedValue({ message: 'ok' }),
  },
  mockTwoFactor: {
    validateLogin2FA: vi.fn().mockResolvedValue(false),
    setup2FA: vi.fn().mockResolvedValue({ secret: 's', qrCodeDataUrl: 'data:img', otpAuthUrl: 'otpauth://x' }),
    verify2FA: vi.fn().mockResolvedValue({ enabled: true, recoveryCodes: ['a', 'b'] }),
    disable2FA: vi.fn().mockResolvedValue({ enabled: false }),
    has2FA: vi.fn().mockResolvedValue(false),
  },
}));
vi.mock('../auth.service', () => mockAuthService);
vi.mock('../two_factor.service', () => mockTwoFactor);

import { authRouter } from '../auth.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  // Centralised error handler matching production behavior
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/register', () => {
  it('201 with userId on success', async () => {
    const res = await request(makeApp()).post('/auth/register').send({ email: 'a@b.com', password: 'pw12345' });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe('u-1');
    expect(mockAuthService.register).toHaveBeenCalledWith('a@b.com', 'pw12345');
  });
});

describe('POST /auth/register/verify-otp', () => {
  it('200 with auth tokens', async () => {
    const res = await request(makeApp()).post('/auth/register/verify-otp').send({ email: 'a@b.com', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u-1');
  });
});

describe('POST /auth/register/resend-otp', () => {
  it('200 with message', async () => {
    const res = await request(makeApp()).post('/auth/register/resend-otp').send({ email: 'a@b.com' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/login', () => {
  it('200 on standard login', async () => {
    const res = await request(makeApp()).post('/auth/login').send({ email: 'a@b.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u-1');
  });

  it('200 with requiresOtp when service flags unverified email', async () => {
    mockAuthService.login.mockResolvedValueOnce({ requiresOtp: true, message: 'verify your email' });
    const res = await request(makeApp()).post('/auth/login').send({ email: 'a@b.com', password: 'pw' });
    expect(res.body.requiresOtp).toBe(true);
  });

  it('200 with requires2FA when 2FA enabled', async () => {
    mockAuthService.login.mockResolvedValueOnce({ requires2FA: true, tempToken: 'temp-1' });
    const res = await request(makeApp()).post('/auth/login').send({ email: 'a@b.com', password: 'pw' });
    expect(res.body).toMatchObject({ requires2FA: true, tempToken: 'temp-1' });
  });
});

describe('POST /auth/google', () => {
  it('200 on success', async () => {
    const res = await request(makeApp()).post('/auth/google').send({ idToken: 'google-id' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u-1');
  });
});

describe('POST /auth/apple', () => {
  it('200 on success', async () => {
    const res = await request(makeApp()).post('/auth/apple').send({ idToken: 'apple-id' });
    expect(res.status).toBe(200);
  });
});

describe('GET /auth/check-username', () => {
  it('returns available=false for username under 3 chars', async () => {
    const res = await request(makeApp()).get('/auth/check-username?username=ab');
    expect(res.body.available).toBe(false);
    expect(mockAuthService.checkUsernameAvailable).not.toHaveBeenCalled();
  });

  it('delegates to service for valid length', async () => {
    const res = await request(makeApp()).get('/auth/check-username?username=alice');
    expect(res.body.available).toBe(true);
    expect(mockAuthService.checkUsernameAvailable).toHaveBeenCalledWith('alice', 'user-1');
  });
});

describe('POST /auth/username', () => {
  it('200 with formatted user', async () => {
    const res = await request(makeApp()).post('/auth/username').send({ username: 'alice' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Alice');
  });
});

describe('POST /auth/anonymous', () => {
  it('200 with auth tokens', async () => {
    const res = await request(makeApp()).post('/auth/anonymous').send({ deviceId: 'dev-1' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/phone', () => {
  it('200 with message', async () => {
    const res = await request(makeApp()).post('/auth/phone').send({ phone: '+1234' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/verify-otp', () => {
  it('200 with auth tokens', async () => {
    const res = await request(makeApp()).post('/auth/verify-otp').send({ phone: '+1234', code: '111111' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u-1');
  });
});

describe('POST /auth/forgot-password', () => {
  it('200', async () => {
    const res = await request(makeApp()).post('/auth/forgot-password').send({ email: 'a@b.com' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/reset-password', () => {
  it('200', async () => {
    const res = await request(makeApp()).post('/auth/reset-password').send({
      email: 'a@b.com', code: '111111', newPassword: 'pw',
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/refresh', () => {
  it('200 with new tokens', async () => {
    const res = await request(makeApp()).post('/auth/refresh').send({ refreshToken: 'tok' });
    expect(res.body.accessToken).toBe('a');
  });
});

describe('POST /auth/logout', () => {
  it('200 on success', async () => {
    const res = await request(makeApp()).post('/auth/logout').send({ refreshToken: 'tok' });
    expect(res.status).toBe(200);
    expect(mockAuthService.logout).toHaveBeenCalledWith('user-1', 'tok');
  });
});

describe('POST /auth/logout-all', () => {
  it('200 with sessionsRevoked count', async () => {
    const res = await request(makeApp()).post('/auth/logout-all').send();
    expect(res.body.sessionsRevoked).toBe(1);
  });
});

describe('GET /auth/sessions', () => {
  it('200 with sessions array', async () => {
    const res = await request(makeApp()).get('/auth/sessions');
    expect(res.body).toEqual({ sessions: [] });
  });
});

describe('error propagation', () => {
  it('forwards thrown errors via next() with statusCode', async () => {
    mockAuthService.login.mockRejectedValueOnce(Object.assign(new Error('bad'), { statusCode: 401 }));
    const res = await request(makeApp()).post('/auth/login').send({ email: 'a@b.com', password: 'pw' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('bad');
  });
});

describe('DELETE /auth/sessions/:sessionId', () => {
  it('revokes a session', async () => {
    const res = await request(makeApp()).delete('/auth/sessions/sess-1');
    expect([200, 204]).toContain(res.status);
  });
});

describe('2FA endpoints', () => {
  it('POST /auth/2fa/login rejects missing fields', async () => {
    const res = await request(makeApp()).post('/auth/2fa/login').send({});
    expect(res.status).toBe(400);
  });

  it('POST /auth/2fa/login completes', async () => {
    (mockAuthService as any).complete2FALogin = vi.fn().mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', userId: 'u-1', user: { id: 'u-1' },
    });
    const res = await request(makeApp())
      .post('/auth/2fa/login')
      .send({ tempToken: 'tt', code: '123456' });
    expect(res.status).toBe(200);
  });

  it('POST /auth/2fa/verify rejects missing code', async () => {
    const res = await request(makeApp()).post('/auth/2fa/verify').send({});
    expect(res.status).toBe(400);
  });

  it('POST /auth/2fa/disable rejects missing code', async () => {
    const res = await request(makeApp()).post('/auth/2fa/disable').send({});
    expect(res.status).toBe(400);
  });

  it('POST /auth/2fa/setup', async () => {
    const res = await request(makeApp()).post('/auth/2fa/setup').send({});
    expect(res.status).toBe(200);
  });

  it('POST /auth/2fa/verify', async () => {
    const res = await request(makeApp()).post('/auth/2fa/verify').send({ code: '123456' });
    expect(res.status).toBe(200);
  });

  it('POST /auth/2fa/disable', async () => {
    const res = await request(makeApp()).post('/auth/2fa/disable').send({ code: '123456' });
    expect(res.status).toBe(200);
  });

  it('GET /auth/2fa/status', async () => {
    mockTwoFactor.has2FA.mockResolvedValueOnce(true);
    const res = await request(makeApp()).get('/auth/2fa/status');
    expect(res.status).toBe(200);
  });
});
