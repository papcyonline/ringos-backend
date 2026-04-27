import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import appleSignIn from 'apple-signin-auth';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { UnauthorizedError, BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { checkBanStatus } from '../safety/safety.service';
import { logSecurityEvent } from '../../shared/audit.service';
import { trackDeviceAndAlert } from '../../shared/device.service';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateAnonymousName,
} from './auth.utils';
import { sendWelcomeEmail, sendPasswordResetEmail, sendOtpEmail } from '../../shared/email.service';
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

/** Fire-and-forget welcome email — logs errors instead of throwing. */
function sendWelcomeEmailAsync(email: string, name: string, userId: string): void {
  sendWelcomeEmail(email, name).catch((err) => {
    logger.error({ error: err, userId }, 'Failed to send welcome email');
  });
}

function refreshTokenExpiryDate(): Date {
  // Parse JWT_REFRESH_EXPIRES_IN default of "7d" — keep it simple: 7 days
  const days = 7;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function createTokenPair(
  tx: Prisma.TransactionClient,
  userId: string,
  isAnonymous: boolean,
): Promise<{ accessToken: string; refreshToken: string; refreshTokenId: string }> {
  const accessToken = generateAccessToken({ userId, isAnonymous });
  const refreshToken = generateRefreshToken({ userId });
  const created = await tx.refreshToken.create({
    data: {
      userId,
      token: refreshToken,
      expiresAt: refreshTokenExpiryDate(),
    },
  });
  return { accessToken, refreshToken, refreshTokenId: created.id };
}

/** Normalize email to lowercase and trimmed. */
function normalizeEmail(rawEmail: string): string {
  return rawEmail.toLowerCase().trim();
}

/** Generate a random 6-digit OTP code. */
function generateOtpCode(): string {
  return crypto.randomInt(1000000).toString().padStart(6, '0');
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

/** Build the standard auth response shape returned by all auth endpoints. */
function buildAuthResponse<T extends Record<string, unknown> = Record<string, never>>(
  user: { id: string; displayName: string; isAnonymous: boolean; avatarUrl?: string | null },
  tokens: { accessToken: string; refreshToken: string },
  extra?: T,
) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    userId: user.id,
    user: {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? undefined,
      isAnonymous: user.isAnonymous,
    },
    ...(extra ?? {}),
  } as {
    accessToken: string;
    refreshToken: string;
    userId: string;
    user: { id: string; displayName: string; avatarUrl: string | undefined; isAnonymous: boolean };
  } & T;
}

/** Deterministic SHA-256 hash for fast indexed phone lookups. */
function phoneToLookup(phone: string): string {
  return crypto.createHash('sha256').update(phone.trim()).digest('hex');
}

export async function anonymousLogin(deviceId: string) {
  const { user, accessToken, refreshToken } = await prisma.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { deviceId } });

    if (!user) {
      user = await tx.user.create({
        data: {
          deviceId,
          displayName: generateAnonymousName(),
          isAnonymous: true,
        },
      });
      logger.info({ userId: user.id }, 'Anonymous user created');
    }

    const tokens = await createTokenPair(tx, user.id, user.isAnonymous);
    return { user, ...tokens };
  });

  return buildAuthResponse(user, { accessToken, refreshToken });
}

export async function register(rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestError('An account with this email already exists');
    }

    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        displayName: generateAnonymousName(),
        isAnonymous: true, // Stays true until profile setup completes
      },
    });

    return user;
  });

  logger.info({ userId: user.id }, 'Email user registered — OTP verification pending');

  // Generate and send email OTP
  const code = generateOtpCode();
  await storeOtp(`email:${email}`, code);

  const emailSent = await sendOtpEmail(email, code);
  if (!emailSent) {
    logger.info({ email, code }, 'Email OTP generated (email not configured — logged for dev)');
  }

  return {
    message: 'OTP sent',
    userId: user.id,
  };
}

export async function verifyEmailOtp(rawEmail: string, code: string) {
  const email = normalizeEmail(rawEmail);
  await verifyStoredOtp(`email:${email}`, code);

  const { user, accessToken, refreshToken } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) {
      throw new BadRequestError('User not found');
    }

    const tokens = await createTokenPair(tx, user.id, user.isAnonymous);
    return { user, ...tokens };
  });

  logger.info({ userId: user.id }, 'Email OTP verified — awaiting profile setup');

  return buildAuthResponse(user, { accessToken, refreshToken });
}

export async function resendEmailOtp(rawEmail: string) {
  const email = normalizeEmail(rawEmail);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new BadRequestError('User not found');
  }

  const code = generateOtpCode();
  await storeOtp(`email:${email}`, code);

  const emailSent = await sendOtpEmail(email, code);
  if (!emailSent) {
    logger.info({ email, code }, 'Email OTP resent (email not configured — logged for dev)');
  }

  logger.info({ userId: user.id }, 'Email OTP resent');

  return { message: 'OTP resent' };
}

/**
 * Compute lock duration in minutes based on failed attempt count.
 * 5 fails → 15 min, 10 fails → 1 hour, 20+ fails → 24 hours.
 */
function computeLockMinutes(attempts: number): number | null {
  if (attempts >= 20) return 24 * 60;
  if (attempts >= 10) return 60;
  if (attempts >= 5) return 15;
  return null;
}

/**
 * Throw if the user is locked. Logs LOGIN_LOCKED security event before throwing.
 */
function assertNotLocked(userId: string, lockedUntil: Date | null, req?: Request) {
  if (lockedUntil && lockedUntil > new Date()) {
    logSecurityEvent({ userId, event: 'LOGIN_LOCKED', req });
    const minutesRemaining = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
    throw new UnauthorizedError(
      `Account locked due to too many failed login attempts. Try again in ${minutesRemaining} minute${minutesRemaining > 1 ? 's' : ''}.`
    );
  }
}

/**
 * Record a failed login attempt and lock the account if threshold reached.
 */
async function recordFailedLogin(userId: string, currentAttempts: number) {
  const newAttempts = currentAttempts + 1;
  const lockMinutes = computeLockMinutes(newAttempts);
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: newAttempts,
      lockedUntil: lockMinutes ? new Date(Date.now() + lockMinutes * 60 * 1000) : null,
    },
  });
}

/**
 * Reset failed login counter on successful authentication.
 */
async function resetFailedLogins(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
}

export async function login(rawEmail: string, password: string, req?: Request) {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    logSecurityEvent({ event: 'LOGIN_FAILED', req, metadata: { email, reason: 'no_user' } });
    throw new UnauthorizedError('Invalid email or password');
  }

  // Block locked accounts before checking the password (prevents enumeration via timing)
  assertNotLocked(user.id, user.lockedUntil, req);

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await recordFailedLogin(user.id, user.failedLoginAttempts);
    logSecurityEvent({ userId: user.id, event: 'LOGIN_FAILED', req, metadata: { reason: 'wrong_password' } });
    throw new UnauthorizedError('Invalid email or password');
  }

  // If user registered but never verified OTP, resend OTP instead of logging in
  if (user.isAnonymous && user.authProvider === 'EMAIL') {
    const code = generateOtpCode();
    await storeOtp(`email:${email}`, code);
    const emailSent = await sendOtpEmail(email, code);
    if (!emailSent) {
      logger.info({ email, code }, 'Email OTP re-generated (email not configured — logged for dev)');
    }
    return { requiresOtp: true, message: 'Please verify your email. A new OTP has been sent.' };
  }

  // Check if user is banned
  const ban = await checkBanStatus(user.id);
  if (ban.banned) {
    throw new ForbiddenError(
      ban.expiresAt
        ? `Your account is temporarily suspended until ${ban.expiresAt.toISOString()}`
        : 'Your account has been permanently suspended'
    );
  }

  // If 2FA is enabled, return a challenge instead of tokens.
  // Don't reset the counter yet — only reset after the full 2FA flow succeeds.
  if (user.twoFactorEnabled) {
    const tempToken = jwt.sign(
      { userId: user.id, purpose: '2fa' },
      process.env.JWT_SECRET!,
      { expiresIn: '5m' },
    );
    logger.info({ userId: user.id }, '2FA challenge issued');
    return { requires2FA: true, tempToken };
  }

  // Successful password login → reset counter
  await resetFailedLogins(user.id);

  const { accessToken, refreshToken } = await prisma.$transaction(async (tx) => {
    return createTokenPair(tx, user.id, user.isAnonymous);
  });

  logger.info({ userId: user.id }, 'Email user logged in');
  logSecurityEvent({ userId: user.id, event: 'LOGIN_SUCCESS', req });

  // Track new device + send alert if unrecognized
  await trackDeviceAndAlert(user.id, user.email, req).catch((err) =>
    logger.error({ err, userId: user.id }, 'Device tracking failed')
  );

  return buildAuthResponse(user, { accessToken, refreshToken });
}

/**
 * Complete login after 2FA verification.
 */
export async function complete2FALogin(tempToken: string, code: string, req?: Request) {
  let payload: any;
  try {
    payload = jwt.verify(tempToken, process.env.JWT_SECRET!);
  } catch {
    throw new UnauthorizedError('Invalid or expired 2FA session');
  }

  if (payload.purpose !== '2fa') {
    throw new UnauthorizedError('Invalid token purpose');
  }

  // Check lock status before verifying — failed 2FA attempts also count toward lockout
  const userPrelock = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { failedLoginAttempts: true, lockedUntil: true },
  });
  if (!userPrelock) throw new NotFoundError('User not found');
  assertNotLocked(payload.userId, userPrelock.lockedUntil, req);

  const { validateLogin2FA } = await import('./two_factor.service');
  const isValid = await validateLogin2FA(payload.userId, code);
  if (!isValid) {
    await recordFailedLogin(payload.userId, userPrelock.failedLoginAttempts);
    logSecurityEvent({ userId: payload.userId, event: '2FA_FAILED', req });
    throw new ForbiddenError('Invalid 2FA code');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) throw new NotFoundError('User not found');

  // Successful full 2FA login → reset counter
  await resetFailedLogins(user.id);

  const { accessToken, refreshToken } = await prisma.$transaction(async (tx) => {
    return createTokenPair(tx, user.id, user.isAnonymous);
  });

  logger.info({ userId: user.id }, '2FA login completed');
  logSecurityEvent({ userId: user.id, event: 'LOGIN_SUCCESS', req, metadata: { method: '2fa' } });

  // Track new device + send alert if unrecognized
  await trackDeviceAndAlert(user.id, user.email, req).catch((err) =>
    logger.error({ err, userId: user.id }, 'Device tracking failed')
  );

  return buildAuthResponse(user, { accessToken, refreshToken });
}

/**
 * Shared social auth flow: find user by provider ID → check email → link/create → tokens → welcome email.
 */
async function socialAuthFlow(params: {
  providerId: string;
  providerField: 'googleId' | 'appleId';
  email: string | null;
  name: string;
  avatarUrl?: string | null;
  authProvider: 'EMAIL' | 'GOOGLE' | 'APPLE' | 'PHONE' | 'ANONYMOUS';
}) {
  const { providerId, providerField, email, name, avatarUrl, authProvider } = params;

  const { user, accessToken, refreshToken, shouldSendWelcome, isNewUser } = await prisma.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { [providerField]: providerId } as any });
    let shouldSendWelcome = false;
    let isNewUser = false;

    if (user) {
      // Check if existing user is banned
      const ban = await checkBanStatus(user.id);
      if (ban.banned) {
        throw new ForbiddenError(
          ban.expiresAt
            ? `Your account is temporarily suspended until ${ban.expiresAt.toISOString()}`
            : 'Your account has been permanently suspended'
        );
      }
      logger.info({ userId: user.id }, `${authProvider} user logged in`);
    } else if (email) {
      const existingEmailUser = await tx.user.findUnique({ where: { email } });

      if (existingEmailUser) {
        user = await tx.user.update({
          where: { id: existingEmailUser.id },
          data: {
            [providerField]: providerId,
            ...(avatarUrl && !existingEmailUser.avatarUrl ? { avatarUrl } : {}),
          },
        });
        logger.info({ userId: user.id }, `${authProvider} account linked to existing email user`);
      } else {
        user = await tx.user.create({
          data: {
            email,
            [providerField]: providerId,
            authProvider,
            displayName: name,
            ...(avatarUrl ? { avatarUrl } : {}),
            isAnonymous: true, // Must complete profile setup
          },
        });
        logger.info({ userId: user.id }, `New ${authProvider} user registered`);
        shouldSendWelcome = true;
        isNewUser = true;
      }
    } else {
      user = await tx.user.create({
        data: {
          [providerField]: providerId,
          authProvider,
          displayName: name,
          isAnonymous: true, // Must complete profile setup
        },
      });
      logger.info({ userId: user.id }, `New ${authProvider} user registered (no email)`);
      isNewUser = true;
    }

    const tokens = await createTokenPair(tx, user.id, user.isAnonymous);
    return { user, ...tokens, shouldSendWelcome, isNewUser };
  });

  if (shouldSendWelcome && email) {
    sendWelcomeEmailAsync(email, name, user.id);
  }

  return buildAuthResponse(user, { accessToken, refreshToken }, { isNewUser });
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

  return socialAuthFlow({
    providerId: googleId,
    providerField: 'googleId',
    email,
    name,
    avatarUrl,
    authProvider: 'GOOGLE',
  });
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

  const name = fullName?.givenName
    ? `${fullName.givenName}${fullName.familyName ? ' ' + fullName.familyName : ''}`.trim()
    : generateAnonymousName();

  return socialAuthFlow({
    providerId: appleId,
    providerField: 'appleId',
    email,
    name,
    authProvider: 'APPLE',
  });
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
  opts?: { avatarUrl?: string; bio?: string; profession?: string; gender?: 'MALE' | 'FEMALE'; location?: string; availabilityNote?: string; language?: string },
) {
  // Validation is handled by Zod schema in the router middleware.
  // Service-level check is only needed for the username uniqueness
  // (which depends on DB state and can't be done in Zod).
  const available = await checkUsernameAvailable(username, userId);
  if (!available) {
    throw new BadRequestError('Username is already taken');
  }

  const data: Record<string, unknown> = {
    displayName: username,
    isAnonymous: false, // Profile complete — user now visible in People tab
    bio: opts?.bio,
    profession: opts?.profession,
    gender: opts?.gender,
    location: opts?.location,
  };
  if (opts?.avatarUrl) data.avatarUrl = opts.avatarUrl;
  if (opts?.availabilityNote) data.availabilityNote = opts.availabilityNote;

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: { displayName: true, avatarUrl: true, bio: true, gender: true, location: true, email: true },
  });

  // Send welcome email now that we have their real name
  if (user.email) {
    sendWelcomeEmail(user.email, username).catch((err) => {
      logger.error({ err, userId }, 'Failed to send welcome email');
    });
  }

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
        isAnonymous: true,
      },
    });
    matchedUser = newUser;
    logger.info({ userId: newUser.id }, 'Phone user created');
  }

  // Generate 6-digit OTP
  const code = generateOtpCode();
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

  const { user, accessToken, refreshToken } = await prisma.$transaction(async (tx) => {
    const lookup = phoneToLookup(phone);
    const user = await tx.user.findUnique({
      where: { phoneLookup: lookup },
      select: { id: true, displayName: true, isAnonymous: true },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    const tokens = await createTokenPair(tx, user.id, user.isAnonymous);
    return { user, ...tokens };
  });

  return buildAuthResponse(user, { accessToken, refreshToken });
}

export async function refreshTokens(token: string, req?: Request) {
  let payload: { userId: string };
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.refreshToken.findUnique({ where: { token } });

    if (!existing) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Defense in depth: ensure the JWT's userId matches the DB record's userId
    if (existing.userId !== payload.userId) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Token reuse detection: if a previously rotated token is presented again,
    // assume it was stolen and revoke ALL tokens for the user (RFC 6819 §5.2.2.3).
    if (existing.revokedAt) {
      // Grace window: legitimate clients can race (e.g. iOS suspends the app
      // mid-refresh during a CallKit call, the response is lost, and the client
      // retries with the old token). If the revocation is recent and the
      // replacement is still active, issue a fresh access token against the
      // replacement instead of wiping all sessions.
      // 5 minutes covers iOS suspension during long calls; the threat model
      // is unchanged because an attacker still needs the legitimate user's
      // exact pre-rotation refresh token AND must replay before the legitimate
      // client's next rotation.
      const GRACE_WINDOW_MS = 5 * 60_000;
      const revokedAgeMs = Date.now() - existing.revokedAt.getTime();
      if (revokedAgeMs <= GRACE_WINDOW_MS && existing.replacedBy) {
        const replacement = await tx.refreshToken.findUnique({
          where: { id: existing.replacedBy },
        });
        if (
          replacement &&
          replacement.revokedAt === null &&
          replacement.expiresAt > new Date()
        ) {
          const user = await tx.user.findUnique({ where: { id: existing.userId } });
          if (user) {
            const accessToken = generateAccessToken({
              userId: user.id,
              isAnonymous: user.isAnonymous,
            });
            return { accessToken, refreshToken: replacement.token };
          }
        }
      }

      await tx.refreshToken.updateMany({
        where: { userId: existing.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      logSecurityEvent({
        userId: existing.userId,
        event: 'TOKEN_REUSE_DETECTED',
        req,
        metadata: { tokenId: existing.id, replacedBy: existing.replacedBy },
      });
      throw new UnauthorizedError('Refresh token has been revoked. Please log in again.');
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token has expired');
    }

    const user = await tx.user.findUnique({ where: { id: existing.userId } });
    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    // Rotate: create new pair, then mark old token as revoked + replaced
    const newPair = await createTokenPair(tx, user.id, user.isAnonymous);
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedBy: newPair.refreshTokenId },
    });

    return { accessToken: newPair.accessToken, refreshToken: newPair.refreshToken };
  });
}

export async function requestPasswordReset(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    const code = generateOtpCode();
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
  const email = normalizeEmail(rawEmail);
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

/**
 * List active (non-revoked, non-expired) sessions for a user.
 * Each session corresponds to one refresh token.
 */
export async function getUserSessions(userId: string) {
  const tokens = await prisma.refreshToken.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return tokens;
}

/**
 * Revoke a specific session (refresh token) by id. User must own it.
 */
export async function revokeSession(userId: string, sessionId: string, req?: Request) {
  const result = await prisma.refreshToken.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    throw new NotFoundError('Session not found');
  }
  logSecurityEvent({ userId, event: 'SESSION_REVOKED', req, metadata: { sessionId } });
  return { message: 'Session revoked' };
}

export async function logoutAll(userId: string) {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { userId },
  });

  logger.info({ userId, sessionsRevoked: count }, 'User logged out from all devices');

  return { message: 'Logged out from all devices', sessionsRevoked: count };
}
