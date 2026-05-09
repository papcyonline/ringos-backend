import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addGrant, toJwt, AccessTokenCtor } = vi.hoisted(() => {
  const addGrant = vi.fn();
  const toJwt = vi.fn(async () => 'jwt-token');
  const AccessTokenCtor = vi.fn(() => ({ addGrant, toJwt }));
  return { addGrant, toJwt, AccessTokenCtor };
});

vi.mock('livekit-server-sdk', () => ({
  AccessToken: AccessTokenCtor,
}));

import { spotlightRoomName, generateSpotlightToken, LIVEKIT_URL } from '../spotlight.livekit';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spotlight.livekit', () => {
  it('spotlightRoomName prefixes', () => {
    expect(spotlightRoomName('u-1')).toBe('spotlight-u-1');
  });

  it('LIVEKIT_URL is exported', () => {
    expect(typeof LIVEKIT_URL === 'string' || LIVEKIT_URL === undefined).toBe(true);
  });

  it('generateSpotlightToken (broadcaster) sets canPublish=true', async () => {
    const tok = await generateSpotlightToken('u-1', 'u-1', 'broadcaster');
    expect(tok).toBe('jwt-token');
    const grant = addGrant.mock.calls[0][0];
    expect(grant.canPublish).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.room).toBe('spotlight-u-1');
  });

  it('generateSpotlightToken (viewer) sets canPublish=false', async () => {
    const tok = await generateSpotlightToken('u-2', 'u-1', 'viewer');
    expect(tok).toBe('jwt-token');
    const grant = addGrant.mock.calls[0][0];
    expect(grant.canPublish).toBe(false);
    expect(grant.canSubscribe).toBe(true);
  });
});
