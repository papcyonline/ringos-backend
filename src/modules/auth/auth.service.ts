import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import appleSignIn from 'apple-signin-auth';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { UnauthorizedError, BadRequestError } from '../../shared/errors';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateAnonymousName,
} from './auth.utils';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../../shared/email.service';
import { sendOtpSms } from '../../shared/sms.service';

// Google OAuth client - accepts tokens from web, iOS, and Android clients.
// Each env var may hold a single ID or a comma-separated list (e.g. for
// multiple Android signing keys / Firebase projects).
const googleClientIds = [
  env.GOOGLE_CLIENT_ID_WEB,
  env.GOOGLE_CLIENT_ID_IOS,
  env.GOOGLE_CLIENT_ID_ANDROID,
]
  .filter(Boolean)
  .flatMap((id) => (id as string).split(',').map((s) => s.trim()))
  .filter(Boolean);

const googleClient = googleClientIds.length > 0 ? new OAuth2Client() : null;

// Apple Sign-In configuration
const appleClientId = env.APPLE_CLIENT_ID;

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

  // Send welcome email (non-blocking)
  sendWelcomeEmail(email, user.displayName).catch((err) => {
    logger.error({ error: err, userId: user.id }, 'Failed to send welcome email');
  });

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

export async function googleAuth(idToken: string) {
  if (!googleClient || googleClientIds.length === 0) {
    throw new BadRequestError('Google Sign-In is not configured');
  }

  // Verify the Google ID token
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: googleClientIds,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.error({ err }, 'Failed to verify Google ID token');
    throw new UnauthorizedError('Invalid Google token');
  }

  if (!payload || !payload.sub || !payload.email) {
    throw new UnauthorizedError('Invalid Google token payload');
  }

  const googleId = payload.sub;
  const email = payload.email.toLowerCase().trim();
  const name = payload.name || generateAnonymousName();
  const avatarUrl = payload.picture || null;

  // Check if user exists with this Google ID
  let user = await prisma.user.findUnique({ where: { googleId } });

  if (user) {
    // Existing Google user - just log them in
    logger.info({ userId: user.id }, 'Google user logged in');
  } else {
    // Check if user exists with same email (email/password or phone account)
    const existingEmailUser = await prisma.user.findUnique({ where: { email } });

    if (existingEmailUser) {
      // Link Google account to existing user
      user = await prisma.user.update({
        where: { id: existingEmailUser.id },
        data: {
          googleId,
          // Keep existing avatar if they have one, otherwise use Google's
          avatarUrl: existingEmailUser.avatarUrl || avatarUrl,
        },
      });
      logger.info({ userId: user.id }, 'Google account linked to existing email user');
    } else {
      // New user - create account with Google
      user = await prisma.user.create({
        data: {
          email,
          googleId,
          authProvider: 'google',
          displayName: name,
          avatarUrl,
          isAnonymous: false,
        },
      });
      logger.info({ userId: user.id }, 'New Google user registered');

      // Send welcome email (non-blocking)
      sendWelcomeEmail(email, name).catch((err) => {
        logger.error({ error: err, userId: user!.id }, 'Failed to send welcome email');
      });
    }
  }

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
      avatarUrl: user.avatarUrl,
      isAnonymous: false,
    },
    isNewUser: !user.createdAt || (Date.now() - user.createdAt.getTime()) < 5000, // Created within last 5 seconds
  };
}

export async function appleAuth(idToken: string, fullName?: { givenName?: string; familyName?: string }) {
  if (!appleClientId) {
    throw new BadRequestError('Apple Sign-In is not configured');
  }

  // Verify the Apple ID token
  let payload;
  try {
    payload = await appleSignIn.verifyIdToken(idToken, {
      audience: appleClientId,
      ignoreExpiration: false,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to verify Apple ID token');
    throw new UnauthorizedError('Invalid Apple token');
  }

  if (!payload || !payload.sub) {
    throw new UnauthorizedError('Invalid Apple token payload');
  }

  const appleId = payload.sub;
  const email = payload.email?.toLowerCase().trim() || null;

  // Apple only sends the name on the first sign-in, so we need to handle it carefully
  const name = fullName?.givenName
    ? `${fullName.givenName}${fullName.familyName ? ' ' + fullName.familyName : ''}`.trim()
    : generateAnonymousName();

  // Check if user exists with this Apple ID
  let user = await prisma.user.findUnique({ where: { appleId } });

  if (user) {
    // Existing Apple user - just log them in
    logger.info({ userId: user.id }, 'Apple user logged in');
  } else if (email) {
    // Check if user exists with same email (email/password or Google account)
    const existingEmailUser = await prisma.user.findUnique({ where: { email } });

    if (existingEmailUser) {
      // Link Apple account to existing user
      user = await prisma.user.update({
        where: { id: existingEmailUser.id },
        data: { appleId },
      });
      logger.info({ userId: user.id }, 'Apple account linked to existing email user');
    } else {
      // New user - create account with Apple
      user = await prisma.user.create({
        data: {
          email,
          appleId,
          authProvider: 'apple',
          displayName: name,
          isAnonymous: false,
        },
      });
      logger.info({ userId: user.id }, 'New Apple user registered');

      // Send welcome email (non-blocking)
      sendWelcomeEmail(email, name).catch((err) => {
        logger.error({ error: err, userId: user!.id }, 'Failed to send welcome email');
      });
    }
  } else {
    // Apple user with private email relay (no email shared)
    user = await prisma.user.create({
      data: {
        appleId,
        authProvider: 'apple',
        displayName: name,
        isAnonymous: false,
      },
    });
    logger.info({ userId: user.id }, 'New Apple user registered (private email)');
  }

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
      avatarUrl: user.avatarUrl,
      isAnonymous: false,
    },
    isNewUser: !user.createdAt || (Date.now() - user.createdAt.getTime()) < 5000,
  };
}

export async function checkUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
  const existing = await prisma.user.findFirst({
    where: {
      displayName: { equals: username, mode: 'insensitive' },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    select: { id: true },
  });
  return !existing;
}

export async function setUsername(
  userId: string,
  username: string,
  opts?: { avatarUrl?: string; bio?: string; profession?: string; gender?: string; location?: string; availabilityNote?: string; language?: string },
) {
  const available = await checkUsernameAvailable(username, userId);
  if (!available) {
    throw new BadRequestError('Username is already taken');
  }

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

  // Send OTP via SMS (falls back to logging if Twilio not configured)
  const smsSent = await sendOtpSms(phone, code);
  if (!smsSent) {
    // Log OTP for development when Twilio is not configured
    logger.info({ phone, code }, 'OTP generated (SMS not configured - logged for dev)');
  }

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

    // Send OTP via email
    const emailSent = await sendPasswordResetEmail(email, code);
    if (emailSent) {
      logger.info({ email }, 'Password reset code sent via email');
    } else {
      logger.info({ email, code }, 'Password reset code generated (email not configured)');
    }
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
