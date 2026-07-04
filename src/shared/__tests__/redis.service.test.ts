import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock ioredis so initRedis() can construct a fake client and exercise
// every code path without a real Redis instance.
const { redisInstance, RedisCtor } = vi.hoisted(() => {
  const redisInstance: any = {
    on: vi.fn().mockReturnThis(),
    connect: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn(),
    exists: vi.fn(),
    expire: vi.fn().mockResolvedValue(1),
    incr: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn(),
    zrange: vi.fn(),
    zadd: vi.fn().mockResolvedValue(1),
    // checkRateLimit now runs a single atomic Lua script via eval.
    eval: vi.fn(),
  };
  const RedisCtor = vi.fn().mockImplementation(() => redisInstance);
  return { redisInstance, RedisCtor };
});

vi.mock('ioredis', () => ({ default: RedisCtor }));
vi.mock('../../config/env', () => ({
  env: { REDIS_URL: 'redis://localhost:6379' },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  initRedis,
  getRedis,
  set,
  get,
  del,
  delPattern,
  exists,
  expire,
  incr,
  checkRateLimit,
  getOrSet,
  cacheKeys,
  closeRedis,
} from '../redis.service';

beforeEach(() => {
  vi.clearAllMocks();
  // Always (re-)initialize the singleton client.
  initRedis();
  // Restore default impls in case a previous test mocked once-impls.
  redisInstance.set.mockResolvedValue('OK');
  redisInstance.del.mockResolvedValue(1);
  redisInstance.expire.mockResolvedValue(1);
  redisInstance.zremrangebyscore.mockResolvedValue(0);
});

describe('initRedis', () => {
  it('returns the same client on repeated calls', async () => {
    const a = initRedis();
    const b = initRedis();
    expect(a).toBe(b);
    expect(a).toBe(getRedis());
  });
});

describe('set / get / del / exists / expire / incr', () => {
  it('set with TTL uses SETEX', async () => {
    expect(await set('k', 'v', 60)).toBe(true);
    expect(redisInstance.setex).toHaveBeenCalledWith('k', 60, 'v');
  });

  it('set without TTL uses plain SET, JSON-stringifies objects', async () => {
    expect(await set('k', { a: 1 })).toBe(true);
    expect(redisInstance.set).toHaveBeenCalledWith('k', '{"a":1}');
  });

  it('set returns false on Redis error', async () => {
    redisInstance.set.mockRejectedValueOnce(new Error('boom'));
    expect(await set('k', 'v')).toBe(false);
  });

  it('get returns null when value missing', async () => {
    redisInstance.get.mockResolvedValueOnce(null);
    expect(await get('k')).toBeNull();
  });

  it('get returns string by default', async () => {
    redisInstance.get.mockResolvedValueOnce('hello');
    expect(await get('k')).toBe('hello');
  });

  it('get with parseJson=true parses JSON', async () => {
    redisInstance.get.mockResolvedValueOnce('{"a":1}');
    expect(await get('k', true)).toEqual({ a: 1 });
  });

  it('get returns null on parse error', async () => {
    redisInstance.get.mockResolvedValueOnce('not-json');
    expect(await get('k', true)).toBeNull();
  });

  it('del returns true on success', async () => {
    expect(await del('k')).toBe(true);
  });

  it('del returns false on error', async () => {
    redisInstance.del.mockRejectedValueOnce(new Error('boom'));
    expect(await del('k')).toBe(false);
  });

  it('exists returns true when key exists (EXISTS=1)', async () => {
    redisInstance.exists.mockResolvedValueOnce(1);
    expect(await exists('k')).toBe(true);
  });

  it('exists returns false when key missing', async () => {
    redisInstance.exists.mockResolvedValueOnce(0);
    expect(await exists('k')).toBe(false);
  });

  it('exists returns false on Redis error', async () => {
    redisInstance.exists.mockRejectedValueOnce(new Error('boom'));
    expect(await exists('k')).toBe(false);
  });

  it('expire returns true on success', async () => {
    expect(await expire('k', 60)).toBe(true);
  });

  it('expire returns false on error', async () => {
    redisInstance.expire.mockRejectedValueOnce(new Error('boom'));
    expect(await expire('k', 60)).toBe(false);
  });

  it('incr returns the new counter value', async () => {
    redisInstance.incr.mockResolvedValueOnce(7);
    expect(await incr('k')).toBe(7);
  });

  it('incr returns null on error', async () => {
    redisInstance.incr.mockRejectedValueOnce(new Error('boom'));
    expect(await incr('k')).toBeNull();
  });
});

describe('delPattern', () => {
  it('returns 0 when no matching keys', async () => {
    redisInstance.keys.mockResolvedValueOnce([]);
    expect(await delPattern('foo:*')).toBe(0);
  });

  it('deletes all matching keys and returns the count', async () => {
    redisInstance.keys.mockResolvedValueOnce(['a', 'b', 'c']);
    redisInstance.del.mockResolvedValueOnce(3);

    expect(await delPattern('foo:*')).toBe(3);
    expect(redisInstance.del).toHaveBeenCalledWith('a', 'b', 'c');
  });

  it('returns 0 on Redis error', async () => {
    redisInstance.keys.mockRejectedValueOnce(new Error('boom'));
    expect(await delPattern('foo:*')).toBe(0);
  });
});

describe('checkRateLimit (Redis path)', () => {
  it('allows when under the limit', async () => {
    // Lua returns [allowed, remaining, resetAtMs].
    redisInstance.eval.mockResolvedValueOnce([1, 2, Date.now() + 60_000]);

    const res = await checkRateLimit('user-1', 5, 60);

    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(2);
  });

  it('blocks when at the limit and returns a future resetAt', async () => {
    const oldestTs = Date.now() - 10_000;
    redisInstance.eval.mockResolvedValueOnce([0, 0, oldestTs + 60_000]);

    const res = await checkRateLimit('user-1', 5, 60);

    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.resetAt).toBeGreaterThan(oldestTs);
  });

  it('falls back to in-memory limiter on Redis error', async () => {
    redisInstance.eval.mockRejectedValueOnce(new Error('redis down'));

    const res = await checkRateLimit('user-fb', 5, 60);

    expect(res.allowed).toBe(true);
  });
});

describe('getOrSet', () => {
  it('returns cached value when present', async () => {
    redisInstance.get.mockResolvedValueOnce('"cached"');

    const factory = vi.fn();
    const res = await getOrSet('k', factory);

    expect(res).toBe('cached');
    expect(factory).not.toHaveBeenCalled();
  });

  it('falls through to factory and caches result on miss', async () => {
    redisInstance.get.mockResolvedValueOnce(null);

    const factory = vi.fn().mockResolvedValue({ v: 42 });
    const res = await getOrSet('k', factory, 30);

    expect(res).toEqual({ v: 42 });
    expect(redisInstance.setex).toHaveBeenCalledWith('k', 30, '{"v":42}');
  });
});

describe('cacheKeys', () => {
  it('builds canonical cache keys', () => {
    expect(cacheKeys.user('u-1')).toBe('user:u-1');
    expect(cacheKeys.userProfile('u-1')).toBe('profile:u-1');
    expect(cacheKeys.conversation('c-1')).toBe('conversation:c-1');
    expect(cacheKeys.onlineUsers()).toBe('online:users');
    expect(cacheKeys.userSession('u-1')).toBe('session:u-1');
  });
});

describe('closeRedis', () => {
  it('quits the client and clears the singleton', async () => {
    await closeRedis();
    expect(redisInstance.quit).toHaveBeenCalled();
    expect(getRedis()).toBeNull();
  });
});
