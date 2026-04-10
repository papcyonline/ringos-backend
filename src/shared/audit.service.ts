import { Request } from 'express';
import { prisma } from '../config/database';
import { logger } from './logger';

/**
 * Security events tracked in the audit log. Add new variants as they're wired in.
 */
export type SecurityEvent =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGIN_LOCKED'
  | '2FA_FAILED'
  | 'NEW_DEVICE_LOGIN'
  | 'TOKEN_REUSE_DETECTED'
  | 'SESSION_REVOKED';

interface LogParams {
  userId?: string | null;
  event: SecurityEvent;
  req?: Request;
  metadata?: Record<string, any>;
}

/**
 * Persist a security event to the audit log. Fire-and-forget — failures are logged but never thrown.
 * Designed to be safe to call inside any request handler without blocking on errors.
 */
export function logSecurityEvent(params: LogParams): void {
  const { userId, event, req, metadata } = params;
  const ipAddress = req?.ip || (req?.headers['x-forwarded-for'] as string) || null;
  const userAgent = (req?.headers['user-agent'] as string) || null;

  prisma.securityAuditLog.create({
    data: {
      userId: userId ?? null,
      event,
      ipAddress,
      userAgent,
      metadata: metadata ?? undefined,
    },
  }).catch((err) => {
    logger.error({ err, event, userId }, 'Failed to write security audit log');
  });
}
