import crypto from 'crypto';
import type { Request } from 'express';
import { prisma } from '../config/database';
import { logger } from './logger';
import { sendNewDeviceLoginEmail } from './email.service';
import { logSecurityEvent } from './audit.service';

/**
 * Generate a stable device fingerprint from user-agent + ip country.
 * Uses Cloudflare's CF-IPCountry header if available, falls back to "unknown".
 */
function deviceFingerprint(userAgent: string, country: string): string {
  return crypto
    .createHash('sha256')
    .update(`${userAgent}|${country}`)
    .digest('hex')
    .slice(0, 32);
}

function extractCountry(req?: Request): string {
  if (!req) return 'unknown';
  // Cloudflare sets this header automatically when proxying through it
  const cfCountry = req.headers['cf-ipcountry'] as string | undefined;
  if (cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1') return cfCountry;
  return 'unknown';
}

function parseUserAgent(ua: string): string {
  // Simple, dependency-free parser — extracts OS + browser/app name for friendly display
  if (ua.includes('Yomeet')) return 'Yomeet App';
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android device';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'Mac';
  if (ua.includes('Windows')) return 'Windows PC';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown device';
}

/**
 * Check if this login is from a new device. If so, record it and email the user.
 * Fire-and-forget — failures should never block login.
 */
export async function trackDeviceAndAlert(
  userId: string,
  userEmail: string | null,
  req?: Request
): Promise<void> {
  if (!req) return;
  const userAgent = (req.headers['user-agent'] as string) || 'Unknown';
  const country = extractCountry(req);
  const ipAddress = req.ip || null;
  const fingerprint = deviceFingerprint(userAgent, country);

  try {
    const existing = await prisma.userDevice.findUnique({
      where: { userId_fingerprint: { userId, fingerprint } },
      select: { id: true },
    });

    if (existing) {
      // Known device — bump lastSeenAt and exit
      await prisma.userDevice.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), ipAddress },
      });
      return;
    }

    // New device — record it
    await prisma.userDevice.create({
      data: { userId, fingerprint, userAgent, ipCountry: country, ipAddress },
    });

    // New device — log and notify
    const deviceName = parseUserAgent(userAgent);
    logSecurityEvent({
      userId,
      event: 'NEW_DEVICE_LOGIN',
      req,
      metadata: { device: deviceName, country },
    });

    if (userEmail) {
      sendNewDeviceLoginEmail(userEmail, {
        deviceName,
        country,
        time: new Date().toLocaleString(),
      }).catch((err) => logger.error({ err, userId }, 'Failed to send new device email'));
    }
  } catch (err) {
    logger.error({ err, userId }, 'trackDeviceAndAlert failed');
  }
}
