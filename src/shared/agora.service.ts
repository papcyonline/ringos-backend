import { RtcTokenBuilder, RtcRole, RtmTokenBuilder, RtmRole } from 'agora-token';
import { env } from '../config/env';
import { logger } from './logger';

// Check if Agora is configured
const isConfigured = !!(env.AGORA_APP_ID && env.AGORA_APP_CERTIFICATE);

const APP_ID = env.AGORA_APP_ID || '';
const APP_CERTIFICATE = env.AGORA_APP_CERTIFICATE || '';

if (isConfigured) {
  logger.info('Agora configured');
}

// Token expiration times
const RTC_TOKEN_EXPIRATION = 3600; // 1 hour for RTC (voice/video)
const RTM_TOKEN_EXPIRATION = 86400; // 24 hours for RTM (messaging)

export interface RtcTokenOptions {
  channelName: string;
  uid: string | number;
  role?: 'publisher' | 'subscriber';
  expirationSeconds?: number;
}

export interface RtmTokenOptions {
  userId: string;
  expirationSeconds?: number;
}

export interface CallTokens {
  appId: string;
  rtcToken: string;
  rtmToken: string;
  channelName: string;
  uid: number;
}

/**
 * Generate an RTC token for voice/video calls
 */
export function generateRtcToken(options: RtcTokenOptions): string | null {
  if (!isConfigured) {
    logger.warn('Agora not configured - cannot generate RTC token');
    return null;
  }

  const role = options.role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
  const expirationTime = Math.floor(Date.now() / 1000) + (options.expirationSeconds || RTC_TOKEN_EXPIRATION);

  // Convert string UID to number if needed (Agora requires numeric UID for RTC)
  const uid = typeof options.uid === 'string' ? stringToUid(options.uid) : options.uid;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      options.channelName,
      uid,
      role,
      expirationTime,
      expirationTime
    );

    logger.debug({ channelName: options.channelName, uid }, 'RTC token generated');
    return token;
  } catch (error) {
    logger.error({ error }, 'Failed to generate RTC token');
    return null;
  }
}

/**
 * Generate an RTM token for real-time messaging
 */
export function generateRtmToken(options: RtmTokenOptions): string | null {
  if (!isConfigured) {
    logger.warn('Agora not configured - cannot generate RTM token');
    return null;
  }

  const expirationTime = Math.floor(Date.now() / 1000) + (options.expirationSeconds || RTM_TOKEN_EXPIRATION);

  try {
    const token = RtmTokenBuilder.buildToken(
      APP_ID,
      APP_CERTIFICATE,
      options.userId,
      RtmRole.Rtm_User,
      expirationTime
    );

    logger.debug({ userId: options.userId }, 'RTM token generated');
    return token;
  } catch (error) {
    logger.error({ error }, 'Failed to generate RTM token');
    return null;
  }
}

/**
 * Generate all tokens needed for a call
 */
export function generateCallTokens(
  channelName: string,
  userId: string
): CallTokens | null {
  if (!isConfigured) {
    logger.warn('Agora not configured');
    return null;
  }

  const uid = stringToUid(userId);
  const rtcToken = generateRtcToken({ channelName, uid, role: 'publisher' });
  const rtmToken = generateRtmToken({ userId });

  if (!rtcToken || !rtmToken) {
    return null;
  }

  return {
    appId: APP_ID,
    rtcToken,
    rtmToken,
    channelName,
    uid,
  };
}

/**
 * Generate tokens for joining an existing call as a subscriber (listener)
 */
export function generateSubscriberTokens(
  channelName: string,
  userId: string
): CallTokens | null {
  if (!isConfigured) {
    return null;
  }

  const uid = stringToUid(userId);
  const rtcToken = generateRtcToken({ channelName, uid, role: 'subscriber' });
  const rtmToken = generateRtmToken({ userId });

  if (!rtcToken || !rtmToken) {
    return null;
  }

  return {
    appId: APP_ID,
    rtcToken,
    rtmToken,
    channelName,
    uid,
  };
}

/**
 * Convert a string user ID to a numeric UID for Agora
 * Uses a hash function to generate a consistent number from the string
 */
function stringToUid(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Ensure positive number within Agora's valid range (1 to 2^32-1)
  return Math.abs(hash) % 4294967295 + 1;
}

/**
 * Get the Agora App ID (for client-side initialization)
 */
export function getAppId(): string | null {
  if (!isConfigured) {
    return null;
  }
  return APP_ID;
}

export { isConfigured as isAgoraConfigured };
