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

// ── In-memory OTP store (MVP only) ─────────────────────
const otpStore = new Map<string, { code: string; expiresAt: number }>();

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
  const phoneHash = await bcrypt.hash(phone, 10);

  // Find existing user by trying all stored hashes (MVP approach)
  // In production, use a deterministic hash or store a phone identifier
  let user = await prisma.user.findFirst({
    where: { phoneHash: { not: null } },
  });

  // Check all users with phoneHash to find a match
  const usersWithPhone = await prisma.user.findMany({
    where: { phoneHash: { not: null } },
    select: { id: true, phoneHash: true, displayName: true, isAnonymous: true },
  });

  let matchedUser = null;
  for (const u of usersWithPhone) {
    if (u.phoneHash && await bcrypt.compare(phone, u.phoneHash)) {
      matchedUser = u;
      break;
    }
  }

  if (!matchedUser) {
    // Create new user with phone
    const newUser = await prisma.user.create({
      data: {
        phoneHash,
        displayName: generateAnonymousName(),
        isAnonymous: false,
      },
    });
    matchedUser = newUser;
    logger.info({ userId: newUser.id }, 'Phone user created');
  }

  // Generate 6-digit OTP
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 min TTL

  // MVP: log OTP instead of sending via SMS
  logger.info({ phone, code }, 'OTP generated (MVP - not sent via SMS)');

  return { message: 'OTP sent successfully' };
}

export async function verifyOtp(phone: string, code: string) {
  const stored = otpStore.get(phone);

  if (!stored) {
    throw new BadRequestError('No OTP requested for this phone number');
  }

  if (Date.now() > stored.expiresAt) {
    otpStore.delete(phone);
    throw new BadRequestError('OTP has expired');
  }

  if (stored.code !== code) {
    throw new BadRequestError('Invalid OTP code');
  }

  otpStore.delete(phone);

  // Find the user by comparing phone hashes
  const usersWithPhone = await prisma.user.findMany({
    where: { phoneHash: { not: null } },
    select: { id: true, phoneHash: true, displayName: true, isAnonymous: true },
  });

  let user = null;
  for (const u of usersWithPhone) {
    if (u.phoneHash && await bcrypt.compare(phone, u.phoneHash)) {
      user = u;
      break;
    }
  }

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
    otpStore.set(`reset:${email}`, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
    logger.info({ email, code }, 'Password reset code generated (MVP - logged to console)');
  }

  return { message: 'If an account with that email exists, a reset code has been sent.' };
}

export async function resetPassword(rawEmail: string, code: string, newPassword: string) {
  const email = rawEmail.toLowerCase().trim();
  const stored = otpStore.get(`reset:${email}`);

  if (!stored) {
    throw new BadRequestError('No reset code requested for this email');
  }

  if (Date.now() > stored.expiresAt) {
    otpStore.delete(`reset:${email}`);
    throw new BadRequestError('Reset code has expired');
  }

  if (stored.code !== code) {
    throw new BadRequestError('Invalid reset code');
  }

  otpStore.delete(`reset:${email}`);

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
