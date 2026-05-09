import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRedisService } = vi.hoisted(() => {
  return {
    mockRedisService: { getRedis: vi.fn() },
  };
});

vi.mock('../../../shared/redis.service', () => mockRedisService);
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
});

// ─── In-memory store ────────────────────────────────────────────────

describe('InMemoryCallStateStore', () => {
  async function freshStore() {
    mockRedisService.getRedis.mockReturnValue(null);
    const mod = await import('../call.state.store');
    return mod.getCallStateStore();
  }

  it('addCall + isUserInCall + getUserCallId roundtrip', async () => {
    const s = await freshStore();
    const call = {
      callId: 'c-1',
      conversationId: 'conv-1',
      initiatorId: 'u-1',
      participantIds: new Set(['u-1', 'u-2']),
      isGroup: false,
      callType: 'AUDIO' as const,
    };
    await s.addCall(call);
    await s.mapUserToCall('u-1', 'c-1');
    await s.mapUserToCall('u-2', 'c-1');

    expect(await s.isUserInCall('u-1')).toBe(true);
    expect(await s.isUserInCall('u-3')).toBe(false);
    expect(await s.getUserCallId('u-1')).toBe('c-1');
  });

  it('markAnswered: first call wins, second call returns false', async () => {
    const s = await freshStore();
    await s.addCall({
      callId: 'c-2', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: new Set(['u-1', 'u-2']), isGroup: false, callType: 'AUDIO',
    });

    expect(await s.markAnswered('c-2', 'u-2', new Date())).toBe(true);
    expect(await s.markAnswered('c-2', 'u-2', new Date())).toBe(false);
    expect(await s.markAnswered('c-bogus', 'u-1', new Date())).toBe(false);
  });

  it('claimTermination: only first claim wins', async () => {
    const s = await freshStore();
    await s.addCall({
      callId: 'c-3', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: new Set(['u-1']), isGroup: false, callType: 'AUDIO',
    });

    expect(await s.claimTermination('c-3')).toBe(true);
    expect(await s.claimTermination('c-3')).toBe(false);
  });

  it('claimTermination returns false for unknown call', async () => {
    const s = await freshStore();
    expect(await s.claimTermination('bogus')).toBe(false);
  });

  it('cleanup removes call + user mappings + push state', async () => {
    const s = await freshStore();
    await s.addCall({
      callId: 'c-4', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: new Set(['u-1', 'u-2']), isGroup: false, callType: 'AUDIO',
    });
    await s.mapUserToCall('u-1', 'c-4');
    await s.mapUserToCall('u-2', 'c-4');
    await s.markPushEnqueued('c-4', 'u-2', Date.now());

    await s.cleanup('c-4');

    expect(await s.getCall('c-4')).toBeUndefined();
    expect(await s.isUserInCall('u-1')).toBe(false);
    expect(await s.isUserInCall('u-2')).toBe(false);
    expect(await s.shouldSuppressCancelPush('c-4', 'u-2', 5000)).toBe(false);
  });

  it('removeParticipant unmaps user but keeps the call', async () => {
    const s = await freshStore();
    await s.addCall({
      callId: 'c-5', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: new Set(['u-1', 'u-2', 'u-3']), isGroup: true, callType: 'VIDEO',
    });
    await s.mapUserToCall('u-2', 'c-5');

    await s.removeParticipant('c-5', 'u-2');

    const call = await s.getCall('c-5');
    expect(call?.participantIds.has('u-2')).toBe(false);
    expect(await s.isUserInCall('u-2')).toBe(false);
    expect(await s.isUserInCall('u-1')).toBe(false); // never mapped
  });

  it('markRinging + hasRingingAcked roundtrip', async () => {
    const s = await freshStore();
    expect(await s.hasRingingAcked('c-6', 'u-1')).toBe(false);
    await s.markRinging('c-6', 'u-1');
    expect(await s.hasRingingAcked('c-6', 'u-1')).toBe(true);
  });

  it('waitForRingingAck resolves immediately when already acked', async () => {
    const s = await freshStore();
    await s.markRinging('c-7', 'u-1');

    expect(await s.waitForRingingAck('c-7', 'u-1', 100)).toBe(true);
  });

  it('waitForRingingAck times out when never acked', async () => {
    const s = await freshStore();
    expect(await s.waitForRingingAck('c-8', 'u-1', 30)).toBe(false);
  });

  it('shouldSuppressCancelPush: true within window when not acked', async () => {
    const s = await freshStore();
    await s.markPushEnqueued('c-9', 'u-1', Date.now());

    expect(await s.shouldSuppressCancelPush('c-9', 'u-1', 5000)).toBe(true);
  });

  it('shouldSuppressCancelPush: false after window elapses', async () => {
    const s = await freshStore();
    await s.markPushEnqueued('c-10', 'u-1', Date.now() - 10000);

    expect(await s.shouldSuppressCancelPush('c-10', 'u-1', 1000)).toBe(false);
  });

  it('shouldSuppressCancelPush: false after acked', async () => {
    const s = await freshStore();
    await s.markPushEnqueued('c-11', 'u-1', Date.now());
    await s.markRinging('c-11', 'u-1');

    expect(await s.shouldSuppressCancelPush('c-11', 'u-1', 5000)).toBe(false);
  });

  it('shouldSuppressCancelPush: false when never enqueued', async () => {
    const s = await freshStore();
    expect(await s.shouldSuppressCancelPush('c-12', 'u-1', 5000)).toBe(false);
  });

  it('setUnansweredTimer replaces an existing timer', async () => {
    const s = await freshStore();
    const t1 = setTimeout(() => {}, 1_000_000);
    const t2 = setTimeout(() => {}, 1_000_000);

    s.setUnansweredTimer('c-13', t1);
    s.setUnansweredTimer('c-13', t2);
    s.clearUnansweredTimer('c-13');
    s.clearUnansweredTimer('c-13'); // idempotent

    clearTimeout(t1);
    clearTimeout(t2);
  });

  it('setDisconnectGrace + takeDisconnectGrace cancels pending timer', async () => {
    const s = await freshStore();
    const handle = setTimeout(() => {}, 1_000_000);

    s.setDisconnectGrace('u-1', handle, 'c-1');
    const taken = s.takeDisconnectGrace('u-1');

    expect(taken).toEqual({ callId: 'c-1' });
    expect(s.takeDisconnectGrace('u-1')).toBeUndefined();
  });

  it('setDisconnectGrace replaces an existing pending grace', async () => {
    const s = await freshStore();
    const t1 = setTimeout(() => {}, 1_000_000);
    const t2 = setTimeout(() => {}, 1_000_000);

    s.setDisconnectGrace('u-1', t1, 'c-1');
    s.setDisconnectGrace('u-1', t2, 'c-2');

    expect(s.takeDisconnectGrace('u-1')).toEqual({ callId: 'c-2' });
    clearTimeout(t1);
    clearTimeout(t2);
  });

  it('takeDisconnectGrace returns undefined when none pending', async () => {
    const s = await freshStore();
    expect(s.takeDisconnectGrace('u-x')).toBeUndefined();
  });

  it('singleton: getCallStateStore returns same instance', async () => {
    mockRedisService.getRedis.mockReturnValue(null);
    const mod = await import('../call.state.store');
    const a = mod.getCallStateStore();
    const b = mod.getCallStateStore();
    expect(a).toBe(b);
  });
});

// ─── Redis-backed store ─────────────────────────────────────────────

describe('RedisCallStateStore', () => {
  function makeRedis() {
    return {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
      exists: vi.fn(),
      pipeline: vi.fn(),
    };
  }

  async function freshStore(redis: any) {
    mockRedisService.getRedis.mockReturnValue(redis);
    const mod = await import('../call.state.store');
    return mod.getCallStateStore();
  }

  it('addCall serializes the call and SETs with TTL', async () => {
    const r = makeRedis();
    r.set.mockResolvedValue('OK');
    const s = await freshStore(r);
    await s.addCall({
      callId: 'c-1', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: new Set(['u-1', 'u-2']), isGroup: true, callType: 'VIDEO',
      answeredAt: new Date('2026-05-08T00:00:00Z'),
    });

    expect(r.set).toHaveBeenCalledWith('call:c-1', expect.any(String), 'EX', 7200);
    const payload = JSON.parse(r.set.mock.calls[0][1] as string);
    expect(payload.participantIds).toEqual(['u-1', 'u-2']);
  });

  it('getCall deserializes and returns ActiveCall', async () => {
    const r = makeRedis();
    r.get.mockResolvedValue(JSON.stringify({
      callId: 'c-1', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: ['u-1', 'u-2'], isGroup: false, callType: 'AUDIO',
    }));
    const s = await freshStore(r);

    const call = await s.getCall('c-1');

    expect(call).toBeDefined();
    expect(call!.participantIds).toBeInstanceOf(Set);
    expect(call!.participantIds.has('u-2')).toBe(true);
  });

  it('getCall returns undefined for malformed JSON', async () => {
    const r = makeRedis();
    r.get.mockResolvedValue('not-json');
    const s = await freshStore(r);

    expect(await s.getCall('c-x')).toBeUndefined();
  });

  it('markAnswered: SET NX wins → reads, writes back, returns true', async () => {
    const r = makeRedis();
    r.set.mockResolvedValueOnce('OK');  // NX lock
    r.get.mockResolvedValueOnce(JSON.stringify({
      callId: 'c-1', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: ['u-1'], isGroup: false, callType: 'AUDIO',
    }));
    r.set.mockResolvedValueOnce('OK');  // call write-back
    const s = await freshStore(r);

    const ok = await s.markAnswered('c-1', 'u-1', new Date());
    expect(ok).toBe(true);
  });

  it('markAnswered: SET NX returns null (already locked) → false', async () => {
    const r = makeRedis();
    r.set.mockResolvedValueOnce(null);
    const s = await freshStore(r);

    expect(await s.markAnswered('c-1', 'u-2', new Date())).toBe(false);
  });

  it('markAnswered: lock taken but call vanished → false + cleanup', async () => {
    const r = makeRedis();
    r.set.mockResolvedValueOnce('OK');  // lock
    r.get.mockResolvedValueOnce(null);  // call gone
    const s = await freshStore(r);

    expect(await s.markAnswered('c-1', 'u-1', new Date())).toBe(false);
    expect(r.del).toHaveBeenCalledWith('call:c-1:answered');
  });

  it('claimTermination uses SET NX', async () => {
    const r = makeRedis();
    r.set.mockResolvedValueOnce('OK');
    const s = await freshStore(r);

    expect(await s.claimTermination('c-1')).toBe(true);
    expect(r.set).toHaveBeenCalledWith('call:c-1:terminating', '1', 'EX', 60, 'NX');
  });

  it('cleanup deletes call + per-participant keys via pipeline', async () => {
    const r = makeRedis();
    r.get.mockResolvedValueOnce(JSON.stringify({
      callId: 'c-1', conversationId: 'conv', initiatorId: 'u-1',
      participantIds: ['u-1', 'u-2'], isGroup: false, callType: 'AUDIO',
    }));
    const pipeline = { del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) };
    r.pipeline.mockReturnValue(pipeline);
    const s = await freshStore(r);

    await s.cleanup('c-1');

    expect(pipeline.del).toHaveBeenCalledWith('call:c-1');
    expect(pipeline.del).toHaveBeenCalledWith('user_call:u-1');
    expect(pipeline.del).toHaveBeenCalledWith('user_call:u-2');
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('cleanup with vanished call still deletes call + answered key', async () => {
    const r = makeRedis();
    r.get.mockResolvedValueOnce(null);
    const s = await freshStore(r);

    await s.cleanup('c-1');

    expect(r.del).toHaveBeenCalledWith('call:c-1', 'call:c-1:answered');
  });

  it('isUserInCall maps EXISTS=1 to true', async () => {
    const r = makeRedis();
    r.exists.mockResolvedValueOnce(1);
    const s = await freshStore(r);
    expect(await s.isUserInCall('u-1')).toBe(true);
  });

  it('isUserInCall maps EXISTS=0 to false', async () => {
    const r = makeRedis();
    r.exists.mockResolvedValueOnce(0);
    const s = await freshStore(r);
    expect(await s.isUserInCall('u-x')).toBe(false);
  });

  it('shouldSuppressCancelPush: true within window when not acked', async () => {
    const r = makeRedis();
    const at = Date.now() - 1000;
    const pipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, null],         // ringingAcked = null
        [null, String(at)],   // pushEnqueued = at
      ]),
    };
    r.pipeline.mockReturnValue(pipeline);
    const s = await freshStore(r);

    expect(await s.shouldSuppressCancelPush('c-1', 'u-1', 5000)).toBe(true);
  });

  it('shouldSuppressCancelPush: false when acked', async () => {
    const r = makeRedis();
    const pipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, '1'],
        [null, String(Date.now())],
      ]),
    };
    r.pipeline.mockReturnValue(pipeline);
    const s = await freshStore(r);

    expect(await s.shouldSuppressCancelPush('c-1', 'u-1', 5000)).toBe(false);
  });
});
