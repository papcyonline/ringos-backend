import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addGrant, toJwt, AccessTokenCtor } = vi.hoisted(() => {
  const addGrant = vi.fn();
  const toJwt = vi.fn(async () => 'jwt-call');
  const AccessTokenCtor = vi.fn(() => ({ addGrant, toJwt }));
  return { addGrant, toJwt, AccessTokenCtor };
});

vi.mock('livekit-server-sdk', () => ({
  AccessToken: AccessTokenCtor,
}));

import { callRoomName, generateCallToken, LIVEKIT_URL } from '../call.livekit';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('call.livekit', () => {
  it('callRoomName prefixes', () => {
    expect(callRoomName('c-1')).toBe('call-c-1');
  });

  it('LIVEKIT_URL is exported', () => {
    expect(typeof LIVEKIT_URL === 'string' || LIVEKIT_URL === undefined).toBe(true);
  });

  it('generateCallToken grants full duplex', async () => {
    const tok = await generateCallToken('u-1', 'c-1', 'Alice');
    expect(tok).toBe('jwt-call');
    const grant = addGrant.mock.calls[0][0];
    expect(grant.canPublish).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.canPublishData).toBe(true);
    expect(grant.room).toBe('call-c-1');
  });

  it('passes displayName to AccessToken', async () => {
    await generateCallToken('u-1', 'c-1', 'Alice');
    expect(AccessTokenCtor).toHaveBeenCalled();
    const opts = (AccessTokenCtor.mock.calls[0] as unknown[])[2] as { name: string };
    expect(opts.name).toBe('Alice');
  });
});
