import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockSpotlight,
  mockCreateDirectCall,
  mockPrisma,
} = vi.hoisted(() => ({
  mockSpotlight: {
    createSpotlightLog: vi.fn().mockResolvedValue('log-1'),
    endSpotlightLog: vi.fn().mockResolvedValue(undefined),
    getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>()),
    buildBroadcasterList: vi.fn().mockResolvedValue([]),
    findOrCreateConversation: vi.fn().mockResolvedValue('c-1'),
    areUsersBlocked: vi.fn().mockResolvedValue(false),
    isUserInCall: vi.fn().mockResolvedValue(false),
  },
  mockCreateDirectCall: vi.fn().mockResolvedValue('call-1'),
  mockPrisma: {
    user: { findUnique: vi.fn() },
    callLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('../spotlight.service', () => mockSpotlight);
vi.mock('../../call/call.gateway', () => ({ createDirectCall: mockCreateDirectCall }));
vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerSpotlightHandlers, liveBroadcasters } from '../spotlight.gateway';

function makeSocket(userId = 'user-1') {
  const handlers: Record<string, Function> = {};
  const socket: any = {
    userId,
    on: vi.fn((event: string, fn: Function) => { handlers[event] = fn; }),
    emit: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
  };
  return { socket, handlers };
}

function makeIO() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const fetchSockets = vi.fn().mockResolvedValue([{ join: vi.fn() }]);
  const io: any = {
    to,
    in: vi.fn(() => ({ fetchSockets })),
    emit,
    _to: to,
    _emit: emit,
  };
  return io;
}

beforeEach(() => {
  vi.clearAllMocks();
  liveBroadcasters.clear();
  mockPrisma.user.findUnique.mockResolvedValue({
    displayName: 'Alice', avatarUrl: null, bio: null, isVerified: false, location: null,
  });
});

afterEach(() => {
  liveBroadcasters.clear();
});

describe('spotlight.gateway', () => {
  it('registers all expected handlers', () => {
    const { socket } = makeSocket();
    registerSpotlightHandlers(makeIO(), socket);
    const events = socket.on.mock.calls.map((c: any) => c[0]);
    expect(events).toEqual(expect.arrayContaining([
      'spotlight:join-room', 'spotlight:leave-room', 'spotlight:go-live',
      'spotlight:end', 'spotlight:viewer-count', 'spotlight:list',
      'spotlight:connect', 'disconnect',
    ]));
  });

  it('join-room joins the live room', () => {
    const { socket, handlers } = makeSocket();
    registerSpotlightHandlers(makeIO(), socket);
    handlers['spotlight:join-room']();
    expect(socket.join).toHaveBeenCalledWith('spotlight:live');
  });

  it('leave-room leaves the live room', () => {
    const { socket, handlers } = makeSocket();
    registerSpotlightHandlers(makeIO(), socket);
    handlers['spotlight:leave-room']();
    expect(socket.leave).toHaveBeenCalledWith('spotlight:live');
  });

  describe('go-live', () => {
    it('starts a broadcast and registers in liveBroadcasters', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:go-live']({ note: 'hi' });
      expect(liveBroadcasters.has('user-1')).toBe(true);
      expect(socket.emit).toHaveBeenCalledWith('spotlight:go-live-ok', expect.objectContaining({ logId: 'log-1' }));
    });

    it('rejects when already live', async () => {
      liveBroadcasters.set('user-1', {} as any);
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:go-live']({});
      expect(socket.emit).toHaveBeenCalledWith('spotlight:error', expect.objectContaining({ message: expect.stringContaining('Already broadcasting') }));
    });

    it('ignores when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:go-live']({});
      expect(liveBroadcasters.has('user-1')).toBe(false);
    });

    it('rejects non-string note', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:go-live']({ note: 123 });
      expect(liveBroadcasters.has('user-1')).toBe(false);
    });

    it('catches errors and emits error event', async () => {
      mockSpotlight.createSpotlightLog.mockRejectedValue(new Error('db'));
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:go-live']({});
      expect(socket.emit).toHaveBeenCalledWith('spotlight:error', expect.any(Object));
    });
  });

  describe('end', () => {
    it('ends a live broadcast', async () => {
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(io, socket);
      liveBroadcasters.set('user-1', {
        logId: 'log-1', peakViewers: 5, totalViewers: 10, connectCount: 1,
      } as any);
      await handlers['spotlight:end']();
      expect(mockSpotlight.endSpotlightLog).toHaveBeenCalled();
      expect(liveBroadcasters.has('user-1')).toBe(false);
    });

    it('no-op when not live', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:end']();
      expect(mockSpotlight.endSpotlightLog).not.toHaveBeenCalled();
    });
  });

  describe('viewer-count', () => {
    it('updates entry and broadcasts to room', () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      const entry: any = { peakViewers: 0 };
      liveBroadcasters.set('user-1', entry);
      handlers['spotlight:viewer-count']({ count: 7 });
      expect(entry.viewerCount).toBe(7);
      expect(entry.peakViewers).toBe(7);
    });

    it('keeps peak at high-water mark', () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      const entry: any = { peakViewers: 10 };
      liveBroadcasters.set('user-1', entry);
      handlers['spotlight:viewer-count']({ count: 3 });
      expect(entry.peakViewers).toBe(10);
    });

    it('ignores when no entry', () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      // Should be no-op
      handlers['spotlight:viewer-count']({ count: 5 });
    });

    it('rejects non-number count', () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      const entry: any = { peakViewers: 0 };
      liveBroadcasters.set('user-1', entry);
      handlers['spotlight:viewer-count']({ count: 'abc' });
      expect(entry.viewerCount).toBeUndefined();
    });
  });

  describe('list', () => {
    it('uses callback when provided', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      const cb = vi.fn();
      await handlers['spotlight:list']({}, cb);
      expect(cb).toHaveBeenCalledWith({ broadcasters: [] });
    });

    it('emits when no callback', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:list']({});
      expect(socket.emit).toHaveBeenCalledWith('spotlight:list', { broadcasters: [] });
    });

    it('returns empty list on error', async () => {
      mockSpotlight.getBlockedUserIds.mockRejectedValueOnce(new Error('db'));
      const cb = vi.fn();
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:list']({}, cb);
      expect(cb).toHaveBeenCalledWith({ broadcasters: [] });
    });
  });

  describe('connect', () => {
    it('rejects missing broadcasterId', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:connect']({});
      // Silent return; no error emitted
    });

    it('rejects when broadcaster not found', async () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:connect']({ broadcasterId: 'nope' });
      expect(socket.emit).toHaveBeenCalledWith('spotlight:error', expect.objectContaining({ message: expect.stringContaining('not found') }));
    });

    it('rejects when blocked', async () => {
      liveBroadcasters.set('u-2', { connectCount: 0 } as any);
      mockSpotlight.areUsersBlocked.mockResolvedValueOnce(true);
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:connect']({ broadcasterId: 'u-2' });
      expect(socket.emit).toHaveBeenCalledWith('spotlight:error', expect.objectContaining({ message: expect.stringContaining('Cannot connect') }));
    });

    it('rejects when either user is in call', async () => {
      liveBroadcasters.set('u-2', { connectCount: 0 } as any);
      mockSpotlight.isUserInCall.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:connect']({ broadcasterId: 'u-2' });
      expect(socket.emit).toHaveBeenCalledWith('spotlight:error', expect.objectContaining({ message: expect.stringContaining('already in a call') }));
    });

    it('successfully connects two users', async () => {
      liveBroadcasters.set('u-2', { displayName: 'Bob', logId: 'log-2', peakViewers: 0, totalViewers: 0, connectCount: 0 } as any);
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(io, socket);
      await handlers['spotlight:connect']({ broadcasterId: 'u-2' });
      expect(mockCreateDirectCall).toHaveBeenCalled();
      expect(io.to).toHaveBeenCalledWith('user:user-1');
      expect(io.to).toHaveBeenCalledWith('user:u-2');
    });

    it('emits error on exception', async () => {
      liveBroadcasters.set('u-2', { connectCount: 0 } as any);
      mockSpotlight.findOrCreateConversation.mockRejectedValueOnce(new Error('db'));
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      await handlers['spotlight:connect']({ broadcasterId: 'u-2' });
      expect(socket.emit).toHaveBeenCalledWith('spotlight:error', expect.any(Object));
    });
  });

  describe('disconnect', () => {
    it('starts grace period when broadcaster disconnects', async () => {
      vi.useFakeTimers();
      try {
        liveBroadcasters.set('user-1', {
          logId: 'log-1', peakViewers: 0, totalViewers: 0, connectCount: 0,
        } as any);
        const io = makeIO();
        const { socket, handlers } = makeSocket();
        registerSpotlightHandlers(io, socket);
        handlers['disconnect']();
        // Timer fires after 10s — broadcast is ended
        await vi.advanceTimersByTimeAsync(11_000);
        expect(liveBroadcasters.has('user-1')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('no-op when not broadcasting', () => {
      const { socket, handlers } = makeSocket();
      registerSpotlightHandlers(makeIO(), socket);
      handlers['disconnect']();
      // No throw
    });
  });
});
