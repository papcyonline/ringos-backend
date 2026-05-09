import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockBcrypt, mockJwt, mockAuthUtils } = vi.hoisted(() => {
  const mockPrisma: any = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    otpCode: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    refreshToken: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    userPreference: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });

  const mockBcrypt = {
    default: {
      hash: vi.fn().mockResolvedValue('$2hashed'),
      compare: vi.fn(),
    },
    hash: vi.fn().mockResolvedValue('$2hashed'),
    compare: vi.fn(),
  };

  const mockJwt = {
    default: {
      sign: vi.fn(() => 'jwt.signed.token'),
      verify: vi.fn(),
    },
    sign: vi.fn(() => 'jwt.signed.token'),
    verify: vi.fn(),
  };

  const mockAuthUtils = {
    generateAccessToken: vi.fn(() => 'access.tok'),
    generateRefreshToken: vi.fn(() => 'refresh.tok'),
    verifyRefreshToken: vi.fn(),
    generateAnonymousName: vi.fn(() => 'Anonymous123'),
  };

  return { mockPrisma, mockBcrypt, mockJwt, mockAuthUtils };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
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
vi.mock('bcryptjs', () => mockBcrypt);
vi.mock('jsonwebtoken', () => mockJwt);
vi.mock('../auth.utils', () => mockAuthUtils);
vi.mock('../../safety/safety.service', () => ({
  checkBanStatus: vi.fn().mockResolvedValue({ banned: false, status: 'NONE' }),
}));
vi.mock('../../../shared/audit.service', () => ({
  logSecurityEvent: vi.fn(),
}));
vi.mock('../../../shared/device.service', () => ({
  trackDeviceAndAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shared/email.service', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
  sendOtpEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../shared/sms.service', () => ({
  sendOtpSms: vi.fn().mockResolvedValue(true),
}));

import {
  anonymousLogin,
  register,
  verifyEmailOtp,
  resendEmailOtp,
  login,
  checkUsernameAvailable,
  setUsername,
  requestOtp,
  verifyOtp,
  refreshTokens,
  requestPasswordReset,
  resetPassword,
  logout,
  getUserSessions,
  revokeSession,
  logoutAll,
} from '../auth.service';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  mockBcrypt.default.hash.mockResolvedValue('$2hashed');
  mockBcrypt.hash.mockResolvedValue('$2hashed');
  mockAuthUtils.generateAccessToken.mockReturnValue('access.tok');
  mockAuthUtils.generateRefreshToken.mockReturnValue('refresh.tok');
  mockAuthUtils.generateAnonymousName.mockReturnValue('Anonymous123');
  mockJwt.default.sign.mockReturnValue('jwt.signed.token');
});

// ─── anonymousLogin ──────────────────────────────────────────────────

describe('anonymousLogin', () => {
  it('creates new anonymous user when device unknown', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'u-1', displayName: 'Anonymous123', isAnonymous: true });
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

    const res = await anonymousLogin('device-1');

    expect(res).toMatchObject({
      accessToken: 'access.tok',
      refreshToken: 'refresh.tok',
      userId: 'u-1',
    });
    expect(mockPrisma.user.create).toHaveBeenCalled();
  });

  it('reuses existing anonymous user for known device', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: 'Existing', isAnonymous: true });
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

    await anonymousLogin('device-1');

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

// ─── register ────────────────────────────────────────────────────────

describe('register', () => {
  it('rejects when email already in use', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });

    await expect(register('A@Test.com', 'pw')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('hashes password, creates user, sends OTP, returns userId', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'u-1' });
    mockPrisma.otpCode.upsert.mockResolvedValue({});

    const res = await register('A@Test.com', 'secret');

    expect(mockBcrypt.default.hash).toHaveBeenCalledWith('secret', 10);
    expect(mockPrisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'a@test.com',
        passwordHash: '$2hashed',
        isAnonymous: true,
      }),
    }));
    expect(mockPrisma.otpCode.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'email:a@test.com' },
    }));
    expect(res).toMatchObject({ message: 'OTP sent', userId: 'u-1' });
  });
});

// ─── verifyEmailOtp ──────────────────────────────────────────────────

describe('verifyEmailOtp', () => {
  it('rejects when no OTP requested', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue(null);

    await expect(verifyEmailOtp('a@b.com', '123456')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects expired OTP and deletes the row', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 0, maxAttempts: 5,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(verifyEmailOtp('a@b.com', '123456')).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.otpCode.delete).toHaveBeenCalledWith({ where: { id: 'o-1' } });
  });

  it('rejects when too many failed attempts', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 5, maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(verifyEmailOtp('a@b.com', 'wrong')).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.otpCode.delete).toHaveBeenCalled();
  });

  it('rejects wrong code and increments attempts', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 1, maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(verifyEmailOtp('a@b.com', 'wrong')).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.otpCode.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { attempts: { increment: 1 } },
    }));
  });

  it('returns auth response on valid OTP and consumes it', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 0, maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: 'Anon', isAnonymous: true });
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

    const res = await verifyEmailOtp('a@b.com', '123456');

    expect(mockPrisma.otpCode.delete).toHaveBeenCalledWith({ where: { id: 'o-1' } });
    expect(res.userId).toBe('u-1');
    expect(res.accessToken).toBe('access.tok');
  });
});

// ─── resendEmailOtp ──────────────────────────────────────────────────

describe('resendEmailOtp', () => {
  it('rejects unknown user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(resendEmailOtp('x@x.com')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('upserts a fresh OTP for the email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.otpCode.upsert.mockResolvedValue({});

    await resendEmailOtp('A@B.com');

    expect(mockPrisma.otpCode.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'email:a@b.com' },
    }));
  });
});

// ─── login ───────────────────────────────────────────────────────────

describe('login', () => {
  it('rejects unknown email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(login('a@b.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects user with no passwordHash (OAuth-only)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', email: 'a@b.com', passwordHash: null });
    await expect(login('a@b.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects locked accounts', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1', passwordHash: 'h', lockedUntil: new Date(Date.now() + 60_000),
      failedLoginAttempts: 5,
    });

    await expect(login('a@b.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('records failed attempt on wrong password', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1', passwordHash: 'h', lockedUntil: null, failedLoginAttempts: 0,
    });
    mockBcrypt.default.compare.mockResolvedValue(false);
    mockBcrypt.compare.mockResolvedValue(false);

    await expect(login('a@b.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ failedLoginAttempts: 1 }),
    }));
  });

  it('returns requiresOtp when user is unverified email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1', passwordHash: 'h', lockedUntil: null, failedLoginAttempts: 0,
      isAnonymous: true, authProvider: 'EMAIL',
    });
    mockBcrypt.default.compare.mockResolvedValue(true);
    mockBcrypt.compare.mockResolvedValue(true);
    mockPrisma.otpCode.upsert.mockResolvedValue({});

    const res = await login('a@b.com', 'pw');

    expect(res).toMatchObject({ requiresOtp: true });
  });

  it('returns 2FA challenge when twoFactorEnabled', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1', passwordHash: 'h', lockedUntil: null, failedLoginAttempts: 0,
      isAnonymous: false, authProvider: 'EMAIL', twoFactorEnabled: true,
    });
    mockBcrypt.default.compare.mockResolvedValue(true);
    mockBcrypt.compare.mockResolvedValue(true);

    const res = await login('a@b.com', 'pw');

    expect(res).toMatchObject({ requires2FA: true, tempToken: 'jwt.signed.token' });
  });

  it('returns access tokens and resets fail counter on success', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1', email: 'a@b.com', passwordHash: 'h', lockedUntil: null,
      failedLoginAttempts: 2, isAnonymous: false, authProvider: 'EMAIL',
      twoFactorEnabled: false, displayName: 'Alice',
    });
    mockBcrypt.default.compare.mockResolvedValue(true);
    mockBcrypt.compare.mockResolvedValue(true);
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

    const res = await login('a@b.com', 'pw');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { failedLoginAttempts: 0, lockedUntil: null },
    }));
    expect(res).toMatchObject({ accessToken: 'access.tok', userId: 'u-1' });
  });

  it('rejects banned user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1', passwordHash: 'h', lockedUntil: null, failedLoginAttempts: 0,
      isAnonymous: false, authProvider: 'EMAIL',
    });
    mockBcrypt.default.compare.mockResolvedValue(true);
    mockBcrypt.compare.mockResolvedValue(true);
    const safety = await import('../../safety/safety.service');
    (safety.checkBanStatus as any).mockResolvedValueOnce({ banned: true, status: 'PERMANENT_BAN' });

    await expect(login('a@b.com', 'pw')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── checkUsernameAvailable ──────────────────────────────────────────

describe('checkUsernameAvailable', () => {
  it('returns true when no match', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    expect(await checkUsernameAvailable('Alice')).toBe(true);
  });

  it('returns false when match exists', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'u-2' });
    expect(await checkUsernameAvailable('Taken')).toBe(false);
  });

  it('excludes self when excludeUserId provided', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await checkUsernameAvailable('Alice', 'user-1');

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { not: 'user-1' },
      }),
    }));
  });
});

// ─── setUsername ─────────────────────────────────────────────────────

describe('setUsername', () => {
  it('rejects when username is taken', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'u-other' });

    await expect(setUsername('user-1', 'Taken')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('updates display name and marks profile complete', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.update.mockResolvedValue({
      displayName: 'Alice', avatarUrl: null, bio: null, gender: null, location: null, email: null,
    });

    await setUsername('user-1', 'Alice');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        displayName: 'Alice',
        isAnonymous: false,
      }),
    }));
  });

  it('upserts language preference when provided', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.update.mockResolvedValue({ displayName: 'Alice', email: null });

    await setUsername('user-1', 'Alice', { language: 'es' });

    expect(mockPrisma.userPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', language: 'es' },
    }));
  });
});

// ─── requestOtp / verifyOtp (phone) ──────────────────────────────────

describe('requestOtp', () => {
  it('creates new user when phone unknown', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'u-1', isAnonymous: true });
    mockPrisma.otpCode.upsert.mockResolvedValue({});

    const res = await requestOtp('+1234');

    expect(mockPrisma.user.create).toHaveBeenCalled();
    expect(mockPrisma.otpCode.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: '+1234' },
    }));
    expect(res.message).toContain('OTP sent');
  });

  it('reuses existing user when phone known', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', isAnonymous: true });
    mockPrisma.otpCode.upsert.mockResolvedValue({});

    await requestOtp('+1234');

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

describe('verifyOtp', () => {
  it('rejects when OTP missing', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue(null);
    await expect(verifyOtp('+1234', '123456')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns auth response on valid OTP', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 0, maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', displayName: 'Anon', isAnonymous: true });
    mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });

    const res = await verifyOtp('+1234', '123456');

    expect(res.userId).toBe('u-1');
  });

  it('throws when user not found despite valid OTP', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 0, maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(verifyOtp('+1234', '123456')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ─── refreshTokens ───────────────────────────────────────────────────

describe('refreshTokens', () => {
  it('rejects malformed token', async () => {
    mockAuthUtils.verifyRefreshToken.mockImplementation(() => { throw new Error('bad'); });
    await expect(refreshTokens('bad.tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects unknown token', async () => {
    mockAuthUtils.verifyRefreshToken.mockReturnValue({ userId: 'u-1' });
    mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

    await expect(refreshTokens('valid.tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects token whose payload userId mismatches DB', async () => {
    mockAuthUtils.verifyRefreshToken.mockReturnValue({ userId: 'u-1' });
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1', userId: 'u-other', revokedAt: null, expiresAt: new Date(Date.now() + 1000),
    });

    await expect(refreshTokens('valid.tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('treats stale revoked token as theft and revokes all', async () => {
    mockAuthUtils.verifyRefreshToken.mockReturnValue({ userId: 'u-1' });
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1',
      userId: 'u-1',
      revokedAt: new Date(Date.now() - 60 * 60 * 1000),  // 1h ago, past grace window
      expiresAt: new Date(Date.now() + 60_000),
      replacedBy: null,
    });

    await expect(refreshTokens('valid.tok')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u-1', revokedAt: null }),
    }));
  });

  it('rejects expired token', async () => {
    mockAuthUtils.verifyRefreshToken.mockReturnValue({ userId: 'u-1' });
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-1', userId: 'u-1', revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(refreshTokens('valid.tok')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ─── requestPasswordReset / resetPassword ────────────────────────────

describe('requestPasswordReset', () => {
  it('returns generic message even when email unknown (anti-enumeration)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await requestPasswordReset('ghost@x.com');

    expect(res.message).toContain('If an account');
    expect(mockPrisma.otpCode.upsert).not.toHaveBeenCalled();
  });

  it('stores reset OTP when email exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    mockPrisma.otpCode.upsert.mockResolvedValue({});

    await requestPasswordReset('a@b.com');

    expect(mockPrisma.otpCode.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'reset:a@b.com' },
    }));
  });
});

describe('resetPassword', () => {
  it('rejects bad OTP', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue(null);

    await expect(resetPassword('a@b.com', '000000', 'newpw')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('updates passwordHash on valid OTP', async () => {
    mockPrisma.otpCode.findUnique.mockResolvedValue({
      id: 'o-1', code: '123456', attempts: 0, maxAttempts: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });

    await resetPassword('a@b.com', '123456', 'newpw');

    expect(mockBcrypt.default.hash).toHaveBeenCalledWith('newpw', 10);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { passwordHash: '$2hashed' },
    }));
  });
});

// ─── session management ─────────────────────────────────────────────

describe('session management', () => {
  it('logout deletes the specific token row', async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    await logout('user-1', 'tok');

    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: 'tok' },
    });
  });

  it('getUserSessions only returns active tokens', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([{ id: 'rt-1', createdAt: new Date(), expiresAt: new Date() }]);

    const res = await getUserSessions('user-1');

    expect(res).toHaveLength(1);
    expect(mockPrisma.refreshToken.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      }),
    }));
  });

  it('revokeSession throws when not found', async () => {
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(revokeSession('user-1', 'rt-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('revokeSession marks revokedAt when found', async () => {
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    await revokeSession('user-1', 'rt-1');

    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { revokedAt: expect.any(Date) },
    }));
  });

  it('logoutAll deletes every token for the user', async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });

    const res = await logoutAll('user-1');

    expect(res.sessionsRevoked).toBe(3);
  });
});
