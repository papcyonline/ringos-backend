import { env } from '../config/env';
import { logger } from './logger';

// Check if Metered is configured
const isConfigured = !!(env.METERED_APP_ID && env.METERED_SECRET_KEY);

const APP_ID = env.METERED_APP_ID || '';
const SECRET_KEY = env.METERED_SECRET_KEY || '';
const METERED_DOMAIN = env.METERED_DOMAIN || 'global.relay.metered.ca';

if (isConfigured) {
  logger.info('Metered configured');
}

export interface TurnCredentials {
  iceServers: IceServer[];
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RoomOptions {
  roomName: string;
  enableRecording?: boolean;
  maxParticipants?: number;
  expiryTime?: number; // Unix timestamp
}

export interface RoomInfo {
  roomName: string;
  appId: string;
  enableRecording: boolean;
  maxParticipants: number;
  createdAt: string;
}

/**
 * Get TURN server credentials for WebRTC
 * These credentials are needed for peer-to-peer connections
 */
export async function getTurnCredentials(): Promise<TurnCredentials | null> {
  if (!isConfigured) {
    logger.warn('Metered not configured - cannot get TURN credentials');
    return null;
  }

  try {
    const response = await fetch(
      `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${SECRET_KEY}`
    );

    if (!response.ok) {
      throw new Error(`Metered API error: ${response.status}`);
    }

    const iceServers = await response.json() as IceServer[];

    logger.debug('TURN credentials retrieved');
    return { iceServers };
  } catch (error) {
    logger.error({ error }, 'Failed to get TURN credentials');
    return null;
  }
}

/**
 * Create a meeting room
 */
export async function createRoom(options: RoomOptions): Promise<RoomInfo | null> {
  if (!isConfigured) {
    logger.warn('Metered not configured');
    return null;
  }

  try {
    const response = await fetch(
      `https://${METERED_DOMAIN}/api/v1/room?apiKey=${SECRET_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: options.roomName,
          enableRecording: options.enableRecording ?? false,
          maxParticipants: options.maxParticipants ?? 2,
          expiryTime: options.expiryTime,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Metered API error: ${response.status} - ${error}`);
    }

    const room = await response.json() as RoomInfo;
    logger.info({ roomName: options.roomName }, 'Metered room created');
    return room;
  } catch (error) {
    logger.error({ error }, 'Failed to create Metered room');
    return null;
  }
}

/**
 * Get room info
 */
export async function getRoom(roomName: string): Promise<RoomInfo | null> {
  if (!isConfigured) {
    return null;
  }

  try {
    const response = await fetch(
      `https://${METERED_DOMAIN}/api/v1/room/${roomName}?apiKey=${SECRET_KEY}`
    );

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Metered API error: ${response.status}`);
    }

    return await response.json() as RoomInfo;
  } catch (error) {
    logger.error({ error, roomName }, 'Failed to get Metered room');
    return null;
  }
}

/**
 * Delete a room
 */
export async function deleteRoom(roomName: string): Promise<boolean> {
  if (!isConfigured) {
    return false;
  }

  try {
    const response = await fetch(
      `https://${METERED_DOMAIN}/api/v1/room/${roomName}?apiKey=${SECRET_KEY}`,
      { method: 'DELETE' }
    );

    if (!response.ok) {
      throw new Error(`Metered API error: ${response.status}`);
    }

    logger.info({ roomName }, 'Metered room deleted');
    return true;
  } catch (error) {
    logger.error({ error, roomName }, 'Failed to delete Metered room');
    return false;
  }
}

/**
 * Get or create a room for a conversation
 * Uses conversation ID as room name for consistency
 */
export async function getOrCreateRoom(conversationId: string): Promise<RoomInfo | null> {
  // Try to get existing room
  const existing = await getRoom(conversationId);
  if (existing) {
    return existing;
  }

  // Create new room
  return createRoom({
    roomName: conversationId,
    maxParticipants: 2,
  });
}

/**
 * Generate call credentials for a user
 * Returns everything needed for the client to join a call
 */
export async function generateCallCredentials(
  conversationId: string,
  userId: string
): Promise<{
  roomName: string;
  domain: string;
  turnCredentials: TurnCredentials;
  userId: string;
} | null> {
  if (!isConfigured) {
    logger.warn('Metered not configured');
    return null;
  }

  // Ensure room exists
  const room = await getOrCreateRoom(conversationId);
  if (!room) {
    return null;
  }

  // Get TURN credentials
  const turnCredentials = await getTurnCredentials();
  if (!turnCredentials) {
    return null;
  }

  logger.debug({ conversationId, userId }, 'Call credentials generated');

  return {
    roomName: conversationId,
    domain: METERED_DOMAIN,
    turnCredentials,
    userId,
  };
}

/**
 * Get the Metered domain for client-side SDK initialization
 */
export function getDomain(): string | null {
  if (!isConfigured) {
    return null;
  }
  return METERED_DOMAIN;
}

export { isConfigured as isMeteredConfigured };
