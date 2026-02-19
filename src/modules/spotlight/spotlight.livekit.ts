import { AccessToken } from 'livekit-server-sdk';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
export const LIVEKIT_URL = process.env.LIVEKIT_URL!;

/**
 * Room name for a broadcaster's Spotlight room.
 * Each broadcaster gets their own LiveKit room.
 */
export function spotlightRoomName(broadcasterId: string): string {
  return `spotlight-${broadcasterId}`;
}

/**
 * Generate a signed LiveKit JWT for a Spotlight participant.
 *
 * - broadcaster: canPublish=true, canSubscribe=false
 * - viewer:      canPublish=false, canSubscribe=true
 */
export async function generateSpotlightToken(
  identity: string,
  broadcasterId: string,
  role: 'broadcaster' | 'viewer',
): Promise<string> {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '2h',
  });

  token.addGrant({
    roomJoin: true,
    room: spotlightRoomName(broadcasterId),
    canPublish: role === 'broadcaster',
    canSubscribe: true,
    canPublishData: false,
  });

  return token.toJwt();
}
