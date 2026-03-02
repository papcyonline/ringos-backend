import { AccessToken } from 'livekit-server-sdk';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
export const LIVEKIT_URL = process.env.LIVEKIT_URL!;

/**
 * Room name for a group call's LiveKit room.
 */
export function callRoomName(callId: string): string {
  return `call-${callId}`;
}

/**
 * Generate a signed LiveKit JWT for a group call participant.
 * All participants can publish and subscribe (full duplex).
 */
export async function generateCallToken(
  identity: string,
  callId: string,
  displayName?: string,
): Promise<string> {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '2h',
    name: displayName,
  });

  token.addGrant({
    roomJoin: true,
    room: callRoomName(callId),
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return token.toJwt();
}
