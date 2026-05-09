import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGoogleClient, mockAppleSignIn, mockJwt, mockTwoFactor } = vi.hoisted(() => {
  const mockPrisma: any = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    refreshToken: { create: vi.fn().mockResolvedValue({ id: 'rt-1' }) },
    $transaction: vi.fn(),
  };
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });

  const mockGoogleClient = {
    verifyIdToken: vi.fn(),
  };

  const mockAppleSignIn = {
    default: { verifyIdToken: vi.fn() },
    verifyIdToken: vi.fn(),
  };

  const mockJwt = {
    default: { sign: vi.fn(() => 'jwt.tok'), verify: vi.fn() },
    sign: vi.fn(() => 'jwt.tok'),
    verify: vi.fn(),
  };

  const mockTwoFactor = {
    validateLogin2FA: vi.fn(),
  };

  return { mockPrisma, mockGoogleClient, mockAppleSignIn, mockJwt, mockTwoFactor };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({
  env: {
    GOOGLE_CLIENT_ID_WEB: 'web-client-id',
    GOOGLE_CLIENT_ID_IOS: 'ios-client-id-1,ios-client-id-2',
    GOOGLE_CLIENT_ID_ANDROID: 'android-client',
    APPLE_CLIENT_ID: 'com.yomeet.app',
  },
}));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => mockGoogleClient),
}));
vi.mock('apple-signin-auth', () => mockAppleSignIn);
vi.mock('jsonwebtoken', () => mockJwt);
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn(), compare: vi.fn() },
  hash: vi.fn(), compare: vi.fn(),
}));
vi.mock('../auth.utils', () => ({
  generateAccessToken: vi.fn(() => 'access.tok'),
  generateRefreshToken: vi.fn(() => 'refresh.tok'),
  verifyRefreshToken: vi.fn(),
  generateAnonymousName: vi.fn(() => 'AnonHero99'),
}));
vi.mock('../two_factor.service', () => mockTwoFactor);
vi.mock('../../safety/safety.service', () => ({
  checkBanStatus: vi.fn().mockResolvedValue({ banned: false }),
}));
vi.mock('../../../shared/audit.service', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('../../../shared/device.service', () => ({
  trackDeviceAndAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shared/email.service', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
  sendOtpEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../shared/sms.service', () => ({ sendOtpSms: vi.fn() }));

import { googleAuth, appleAuth, complete2FALogin } from '../auth.service';
import { BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
});

describe('googleAuth', () => {
  it('rejects invalid Google token', async () => {
    mockGoogleClient.verifyIdToken.mockRejectedValueOnce(new Error('bad'));
    await expect(googleAuth('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects empty payload', async () => {
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({ getPayload: () => null });
    await expect(googleAuth('tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects payload missing sub or email', async () => {
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'sub1' }),
    });
    await expect(googleAuth('tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('logs in existing google user', async () => {
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'g-1', email: 'X@TEST.COM', name: 'Greg', picture: 'pic.jpg' }),
    });
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', isAnonymous: false });
    const res = await googleAuth('tok');
    expect(res).toMatchObject({ accessToken: 'access.tok', userId: 'u-1' });
  });

  it('blocks banned google user', async () => {
    const safety = await import('../../safety/safety.service');
    (safety.checkBanStatus as any).mockResolvedValueOnce({
      banned: true, expiresAt: new Date('2030-01-01'),
    });
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'g-1', email: 'a@b.com' }),
    });
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', isAnonymous: false });
    await expect(googleAuth('tok')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('blocks permanently banned google user', async () => {
    const safety = await import('../../safety/safety.service');
    (safety.checkBanStatus as any).mockResolvedValueOnce({ banned: true });
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'g-1', email: 'a@b.com' }),
    });
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', isAnonymous: false });
    await expect(googleAuth('tok')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('links google to existing email user', async () => {
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'g-1', email: 'a@b.com', name: 'A', picture: 'pic' }),
    });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'u-1', avatarUrl: null });
    mockPrisma.user.update.mockResolvedValueOnce({ id: 'u-1', isAnonymous: false });
    await googleAuth('tok');
    expect(mockPrisma.user.update).toHaveBeenCalled();
  });

  it('creates new google user when no email match', async () => {
    mockGoogleClient.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'g-1', email: 'new@b.com', name: 'New' }),
    });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockPrisma.user.create.mockResolvedValueOnce({ id: 'u-new', isAnonymous: true });
    const res = await googleAuth('tok');
    expect(res).toMatchObject({ isNewUser: true });
    expect(mockPrisma.user.create).toHaveBeenCalled();
  });
});

describe('appleAuth', () => {
  it('rejects invalid apple token', async () => {
    mockAppleSignIn.default.verifyIdToken.mockRejectedValueOnce(new Error('bad'));
    await expect(appleAuth('tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects payload missing sub', async () => {
    mockAppleSignIn.default.verifyIdToken.mockResolvedValueOnce({ email: 'x@y.com' });
    await expect(appleAuth('tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('logs in existing apple user', async () => {
    mockAppleSignIn.default.verifyIdToken.mockResolvedValueOnce({ sub: 'a-1', email: 'a@b.com' });
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', isAnonymous: false });
    const res = await appleAuth('tok');
    expect(res).toMatchObject({ userId: 'u-1' });
  });

  it('creates new apple user with provided fullName', async () => {
    mockAppleSignIn.default.verifyIdToken.mockResolvedValueOnce({ sub: 'a-2', email: 'a2@b.com' });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockPrisma.user.create.mockResolvedValueOnce({ id: 'u-new', isAnonymous: true });
    const res = await appleAuth('tok', { givenName: 'Apple', familyName: 'User' });
    expect(res).toMatchObject({ isNewUser: true });
  });

  it('creates new apple user without email', async () => {
    mockAppleSignIn.default.verifyIdToken.mockResolvedValueOnce({ sub: 'a-3' });
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockPrisma.user.create.mockResolvedValueOnce({ id: 'u-new', isAnonymous: true });
    const res = await appleAuth('tok', { givenName: 'No', familyName: 'Email' });
    expect(res).toMatchObject({ isNewUser: true });
  });

  it('creates new apple user without fullName uses anon name', async () => {
    mockAppleSignIn.default.verifyIdToken.mockResolvedValueOnce({ sub: 'a-4' });
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockPrisma.user.create.mockResolvedValueOnce({ id: 'u-new', isAnonymous: true });
    await appleAuth('tok');
    expect(mockPrisma.user.create).toHaveBeenCalled();
  });
});

describe('complete2FALogin', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  it('rejects invalid temp token', async () => {
    mockJwt.default.verify.mockImplementationOnce(() => { throw new Error('bad'); });
    await expect(complete2FALogin('bad', '123456')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects token with wrong purpose', async () => {
    mockJwt.default.verify.mockReturnValueOnce({ userId: 'u-1', purpose: 'reset' });
    await expect(complete2FALogin('tok', '123456')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws NotFoundError when user gone', async () => {
    mockJwt.default.verify.mockReturnValueOnce({ userId: 'u-1', purpose: '2fa' });
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(complete2FALogin('tok', '123456')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when 2FA code is invalid', async () => {
    mockJwt.default.verify.mockReturnValueOnce({ userId: 'u-1', purpose: '2fa' });
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1', failedLoginAttempts: 0, lockedUntil: null,
    });
    mockPrisma.user.update = vi.fn().mockResolvedValue({});
    mockTwoFactor.validateLogin2FA.mockResolvedValueOnce(false);
    await expect(complete2FALogin('tok', '000000')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('completes successfully when 2FA code is valid', async () => {
    mockJwt.default.verify.mockReturnValueOnce({ userId: 'u-1', purpose: '2fa' });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'u-1', failedLoginAttempts: 0, lockedUntil: null })
      .mockResolvedValueOnce({ id: 'u-1', email: 'a@b.com', isAnonymous: false });
    mockPrisma.user.update = vi.fn().mockResolvedValue({});
    mockTwoFactor.validateLogin2FA.mockResolvedValueOnce(true);
    const res = await complete2FALogin('tok', '123456');
    expect(res).toMatchObject({ accessToken: 'access.tok', userId: 'u-1' });
  });

  it('rejects when user is locked', async () => {
    mockJwt.default.verify.mockReturnValueOnce({ userId: 'u-1', purpose: '2fa' });
    const lockedUntil = new Date(Date.now() + 60_000);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1', failedLoginAttempts: 5, lockedUntil,
    });
    await expect(complete2FALogin('tok', '123456')).rejects.toThrow(/locked/i);
  });
});
