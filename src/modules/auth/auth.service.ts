import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { UnauthorizedError, BadRequestError } from '../../shared/errors';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateAnonymousName,
} from './auth.utils';

function refreshTokenExpiryDate(): Date {
  // Parse JWT_REFRESH_EXPIRES_IN default of "7d" — keep it simple: 7 days
  const days = 7;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ── OTP helpers (database-backed) ──────────────────────

async function storeOtp(key: string, code: string, ttlMs: number = 5 * 60 * 1000) {
  await prisma.otpCode.upsert({
    where: { key },
    create: { key, code, expiresAt: new Date(Date.now() + ttlMs) },
    update: { code, attempts: 0, expiresAt: new Date(Date.now() + ttlMs) },
  });
}

async function verifyStoredOtp(key: string, code: string): Promise<void> {
  const stored = await prisma.otpCode.findUnique({ where: { key } });

  if (!stored) {
    throw new BadRequestError('No OTP requested');
  }

  if (new Date() > stored.expiresAt) {
    await prisma.otpCode.delete({ where: { id: stored.id } });
    throw new BadRequestError('OTP has expired');
  }

  if (stored.attempts >= stored.maxAttempts) {
    await prisma.otpCode.delete({ where: { id: stored.id } });
    throw new BadRequestError('Too many failed attempts. Please request a new code.');
  }

  if (stored.code !== code) {
    await prisma.otpCode.update({
      where: { id: stored.id },
      data: { attempts: { increment: 1 } },
    });
    throw new BadRequestError('Invalid OTP code');
  }

  // Valid — delete the used OTP
  await prisma.otpCode.delete({ where: { id: stored.id } });
}

/** Deterministic SHA-256 hash for fast indexed phone lookups. */
function phoneToLookup(phone: string): string {
  return crypto.createHash('sha256').update(phone.trim()).digest('hex');
}

export async function anonymousLogin(deviceId: string) {
  let user = await prisma.user.findUnique({ where: { deviceId } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        deviceId,
        displayName: generateAnonymousName(),
        isAnonymous: true,
      },
    });
    logger.info({ userId: user.id }, 'Anonymous user created');
  }

  const accessToken = generateAccessToken({ userId: user.id, isAnonymous: user.isAnonymous });
  const refreshToken = generateRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: refreshTokenExpiryDate(),
    },
  });

  return {
    accessToken,
    refreshToken,
    userId: user.id,
    user: {
      id: user.id,
      displayName: user.displayName,
      isAnonymous: user.isAnonymous,
    },
  };
}

export async function register(rawEmail: string, password: string) {
  const email = rawEmail.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new BadRequestError('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName: generateAnonymousName(),
      isAnonymous: false,
    },
  });

  logger.info({ userId: user.id }, 'Email user registered');

  const accessToken = generateAccessToken({ userId: user.id, isAnonymous: false });
  const refreshToken = generateRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: refreshTokenExpiryDate(),
    },
  });

  return {
    accessToken,
    refreshToken,
    userId: user.id,
    user: {
      id: user.id,
      displayName: user.displayName,
      isAnonymous: false,
    },
  };
}

export async function login(rawEmail: string, password: string) {
  const email = rawEmail.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const accessToken = generateAccessToken({ userId: user.id, isAnonymous: user.isAnonymous });
  const refreshToken = generateRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: refreshTokenExpiryDate(),
    },
  });

  logger.info({ userId: user.id }, 'Email user logged in');

  return {
    accessToken,
    refreshToken,
    userId: user.id,
    user: {
      id: user.id,
      displayName: user.displayName,
      isAnonymous: user.isAnonymous,
    },
  };
}

export async function setUsername(
  userId: string,
  username: string,
  opts?: { avatarUrl?: string; bio?: string; profession?: string; gender?: string; location?: string; availabilityNote?: string; language?: string },
) {
  const data: Record<string, unknown> = { displayName: username };
  if (opts?.avatarUrl) data.avatarUrl = opts.avatarUrl;
  if (opts?.bio) data.bio = opts.bio;
  if (opts?.profession) data.profession = opts.profession;
  if (opts?.gender) data.gender = opts.gender;
  if (opts?.location) data.location = opts.location;
  if (opts?.availabilityNote) data.availabilityNote = opts.availabilityNote;

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: { displayName: true, avatarUrl: true, bio: true, gender: true, location: true },
  });

  // If language was provided, save it to preferences
  if (opts?.language) {
    await prisma.userPreference.upsert({
      where: { userId },
      create: { userId, language: opts.language },
      update: { language: opts.language },
    });
  }

  logger.info({ userId, username }, 'Username set');

  return user;
}

export async function requestOtp(phone: string) {
  const lookup = phoneToLookup(phone);

  // Fast O(1) indexed lookup by deterministic hash
  let matchedUser = await prisma.user.findUnique({
    where: { phoneLookup: lookup },
    select: { id: true, displayName: true, isAnonymous: true },
  });

  if (!matchedUser) {
    // Create new user with phone
    const phoneHash = await bcrypt.hash(phone, 10);
    const newUser = await prisma.user.create({
      data: {
        phoneHash,
        phoneLookup: lookup,
        displayName: generateAnonymousName(),
        isAnonymous: false,
      },
    });
    matchedUser = newUser;
    logger.info({ userId: newUser.id }, 'Phone user created');
  }

  // Generate 6-digit OTP
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await storeOtp(phone, code);

  // MVP: log OTP instead of sending via SMS
  logger.info({ phone, code }, 'OTP generated (MVP - not sent via SMS)');

  return { message: 'OTP sent successfully' };
}

export async function verifyOtp(phone: string, code: string) {
  await verifyStoredOtp(phone, code);

  // Fast O(1) indexed lookup by deterministic hash
  const lookup = phoneToLookup(phone);
  const user = await prisma.user.findUnique({
    where: { phoneLookup: lookup },
    select: { id: true, displayName: true, isAnonymous: true },
  });

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  const accessToken = generateAccessToken({ userId: user.id, isAnonymous: user.isAnonymous });
  const refreshToken = generateRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: refreshTokenExpiryDate(),
    },
  });

  return {
    accessToken,
    refreshToken,
    userId: user.id,
    user: {
      id: user.id,
      displayName: user.displayName,
      isAnonymous: user.isAnonymous,
    },
  };
}

export async function refreshTokens(token: string) {
  let payload: { userId: string };
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  // Find and delete the old refresh token
  const existing = await prisma.refreshToken.findUnique({ where: { token } });

  if (!existing) {
    throw new UnauthorizedError('Refresh token not found or already used');
  }

  if (existing.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: existing.id } });
    throw new UnauthorizedError('Refresh token has expired');
  }

  await prisma.refreshToken.delete({ where: { id: existing.id } });

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  const accessToken = generateAccessToken({ userId: user.id, isAnonymous: user.isAnonymous });
  const refreshToken = generateRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: refreshTokenExpiryDate(),
    },
  });

  return { accessToken, refreshToken };
}

export async function requestPasswordReset(rawEmail: string) {
  const email = rawEmail.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await storeOtp(`reset:${email}`, code);
    logger.info({ email, code }, 'Password reset code generated (MVP - logged to console)');
  }

  return { message: 'If an account with that email exists, a reset code has been sent.' };
}

export async function resetPassword(rawEmail: string, code: string, newPassword: string) {
  const email = rawEmail.toLowerCase().trim();
  await verifyStoredOtp(`reset:${email}`, code);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new BadRequestError('User not found');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  logger.info({ userId: user.id }, 'Password reset successfully');

  return { message: 'Password has been reset successfully. Please log in with your new password.' };
}

export async function logout(userId: string, token: string) {
  await prisma.refreshToken.deleteMany({
    where: { userId, token },
  });

  logger.info({ userId }, 'User logged out');

  return { message: 'Logged out successfully' };
}
