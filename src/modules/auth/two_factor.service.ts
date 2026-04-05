import { generate, verify, generateSecret, generateURI } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { NotFoundError, BadRequestError, ForbiddenError } from '../../shared/errors';

const APP_NAME = 'Yomeet';
const RECOVERY_CODE_COUNT = 8;

/**
 * Generate a TOTP secret and QR code for 2FA setup.
 * Does NOT enable 2FA yet — user must verify a code first.
 */
export async function setup2FA(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true, twoFactorEnabled: true },
  });

  if (!user) throw new NotFoundError('User not found');
  if (user.twoFactorEnabled) throw new BadRequestError('2FA is already enabled');

  const secret = generateSecret();

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: secret },
  });

  const accountName = user.email ?? user.displayName;
  const otpAuthUrl = generateURI({ secret, issuer: APP_NAME, label: accountName });
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

  return { secret, qrCodeDataUrl, otpAuthUrl };
}

/**
 * Verify a TOTP code and enable 2FA if correct.
 * Generates recovery codes on first enable.
 */
export async function verify2FA(userId: string, code: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true, twoFactorEnabled: true },
  });

  if (!user) throw new NotFoundError('User not found');
  if (!user.twoFactorSecret) throw new BadRequestError('2FA setup not started');

  const result = await verify({ token: code, secret: user.twoFactorSecret });
  if (!result.valid) throw new ForbiddenError('Invalid verification code');

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    crypto.randomBytes(4).toString('hex'),
  );

  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorEnabled: true,
      twoFactorRecovery: recoveryCodes,
    },
  });

  return { enabled: true, recoveryCodes };
}

/**
 * Disable 2FA after verifying the current code.
 */
export async function disable2FA(userId: string, code: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true, twoFactorEnabled: true },
  });

  if (!user) throw new NotFoundError('User not found');
  if (!user.twoFactorEnabled) throw new BadRequestError('2FA is not enabled');

  const result = await verify({ token: code, secret: user.twoFactorSecret! });
  if (!result.valid) throw new ForbiddenError('Invalid verification code');

  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorRecovery: [],
    },
  });

  return { enabled: false };
}

/**
 * Validate a TOTP code during login.
 * Also accepts recovery codes (single-use).
 */
export async function validateLogin2FA(userId: string, code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true, twoFactorEnabled: true, twoFactorRecovery: true },
  });

  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) return false;

  // Try TOTP code first
  const result = await verify({ token: code, secret: user.twoFactorSecret });
  if (result.valid) return true;

  // Try recovery code (single-use)
  const recoveryIndex = user.twoFactorRecovery.indexOf(code);
  if (recoveryIndex >= 0) {
    const updatedCodes = [...user.twoFactorRecovery];
    updatedCodes.splice(recoveryIndex, 1);
    await prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecovery: updatedCodes },
    });
    return true;
  }

  return false;
}

/**
 * Check if a user has 2FA enabled.
 */
export async function has2FA(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true },
  });
  return user?.twoFactorEnabled ?? false;
}
