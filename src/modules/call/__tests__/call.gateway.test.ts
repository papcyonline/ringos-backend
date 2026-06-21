import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockPrisma,
  mockNotif,
  mockUsage,
  mockLiveKit,
  mockSafety,
  mockCallState,
  mockCallLogWriter,
} = vi.hoisted(() => ({
  mockPrisma: {
    conversationParticipant: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    callLog: { create: vi.fn(), update: vi.fn() },
  },
  mockNotif: {
    sendCallPush: vi.fn().mockResolvedValue(undefined),
    sendCallCancelPush: vi.fn().mockResolvedValue(undefined),
    sendMissedCallNotification: vi.fn().mockResolvedValue(undefined),
  },
  mockUsage: {
    checkCallMinutes: vi.fn().mockResolvedValue({ allowed: true }),
    addCallMinutes: vi.fn().mockResolvedValue(undefined),
  },
  mockLiveKit: {
    generateCallToken: vi.fn().mockResolvedValue('jwt-token'),
    LIVEKIT_URL: 'wss://lk',
  },
  mockSafety: {
    isBlocked: vi.fn().mockResolvedValue(false),
  },
  mockCallState: {
    addCall: vi.fn().mockResolvedValue(undefined),
    getCall: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    isUserInCall: vi.fn().mockResolvedValue(false),
    mapUserToCall: vi.fn().mockResolvedValue(undefined),
    unmapUser: vi.fn().mockResolvedValue(undefined),
    getUserCallId: vi.fn().mockResolvedValue(null),
    setAnsweredAt: vi.fn().mockResolvedValue(undefined),
    markPushEnqueued: vi.fn().mockResolvedValue(undefined),
    hasRingingAcked: vi.fn().mockResolvedValue(false),
    markRinging: vi.fn().mockResolvedValue(undefined),
    addParticipant: vi.fn().mockResolvedValue(undefined),
    removeParticipant: vi.fn().mockResolvedValue(undefined),
    setDisconnectGrace: vi.fn(),
    takeDisconnectGrace: vi.fn().mockReturnValue(undefined),
    markAnswered: vi.fn().mockResolvedValue(true),
    isTerminating: vi.fn().mockResolvedValue(false),
    clearUnansweredTimer: vi.fn(),
    claimTermination: vi.fn().mockResolvedValue(true),
    shouldSuppressCancelPush: vi.fn().mockResolvedValue(false),
    waitForRingingAck: vi.fn().mockResolvedValue(false),
    setUnansweredTimer: vi.fn(),
  },
  mockCallLogWriter: { enqueue: vi.fn() },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../notification/notification.service', () => mockNotif);
vi.mock('../../../shared/usage.service', () => mockUsage);
vi.mock('../call.livekit', () => mockLiveKit);
vi.mock('../../safety/safety.service', () => mockSafety);
vi.mock('../call.state.store', () => ({
  getCallStateStore: () => mockCallState,
}));
vi.mock('../call.log.writer', () => ({ callLogWriter: mockCallLogWriter }));

import { isUserInCall, createDirectCall, registerCallHandlers } from '../call.gateway';

function makeIO() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const fetchSockets = vi.fn().mockResolvedValue([]);
  return {
    to, emit,
    in: vi.fn(() => ({ fetchSockets })),
    _emit: emit, _to: to, _fetchSockets: fetchSockets,
  } as any;
}

function makeSocket(userId = 'user-1') {
  const handlers: Record<string, Function> = {};
  const toEmit = vi.fn();
  const socket: any = {
    userId,
    on: vi.fn((event: string, fn: Function) => { handlers[event] = fn; }),
    emit: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    to: vi.fn(() => ({ emit: toEmit })),
    _toEmit: toEmit,
  };
  return { socket, handlers };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCallState.isUserInCall.mockResolvedValue(false);
  mockCallState.takeDisconnectGrace.mockReturnValue(undefined);
  mockCallState.getUserCallId.mockResolvedValue(null);
  mockCallState.getCall.mockResolvedValue(null);
});

describe('call.gateway — exported helpers', () => {
  it('isUserInCall delegates to store', async () => {
    mockCallState.isUserInCall.mockResolvedValue(true);
    expect(await isUserInCall('u-1')).toBe(true);
  });

  it('createDirectCall creates call and maps participants', async () => {
    const callId = await createDirectCall({
      conversationId: 'c-1',
      initiatorId: 'u-1',
      participantIds: ['u-1', 'u-2'],
      callType: 'VIDEO',
    });
    expect(typeof callId).toBe('string');
    expect(mockCallState.addCall).toHaveBeenCalled();
    expect(mockCallState.mapUserToCall).toHaveBeenCalledTimes(2);
  });
});

describe('call.gateway — registerCallHandlers', () => {
  it('registers all expected events', async () => {
    const { socket } = makeSocket();
    await registerCallHandlers(makeIO(), socket);
    const events = socket.on.mock.calls.map((c: any) => c[0]);
    expect(events).toEqual(expect.arrayContaining([
      'call:initiate', 'call:ringing', 'call:answer', 'call:reject',
      'call:signal', 'call:request-token', 'call:end', 'call:reaction', 'disconnect',
    ]));
  });

  it('reconnects: cancels disconnect grace if reconnecting during call', async () => {
    mockCallState.takeDisconnectGrace.mockReturnValueOnce({ callId: 'call-1' });
    mockCallState.getCall.mockResolvedValueOnce({
      callId: 'call-1',
      participantIds: new Set(['user-1']),
    });
    const { socket } = makeSocket();
    await registerCallHandlers(makeIO(), socket);
    expect(socket.join).toHaveBeenCalledWith('call:call-1');
  });

  describe('call:initiate', () => {
    it('rejects empty target list', async () => {
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: [] });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ message: expect.stringContaining('Invalid number') }));
    });

    it('rejects too many targets', async () => {
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({
        conversationId: 'c-1',
        targetUserIds: Array.from({ length: 21 }, (_, i) => `u-${i}`),
      });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ message: expect.stringContaining('Invalid number') }));
    });

    it('rejects when daily call minutes exhausted', async () => {
      mockUsage.checkCallMinutes.mockResolvedValueOnce({ allowed: false, resetAt: 'tomorrow' });
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ code: 'CALL_LIMIT' }));
    });

    it('rejects when caller not a participant', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ message: expect.stringContaining('not a participant') }));
    });

    it('rejects when user is already in another active call', async () => {
      mockCallState.getUserCallId.mockResolvedValue('old-call');
      mockCallState.getCall.mockResolvedValue({
        callId: 'old-call',
        answeredAt: new Date(),
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ message: expect.stringContaining('already in a call') }));
    });

    it('rejects 1-on-1 when target is blocked', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'u-2', leftAt: null }]);
      mockSafety.isBlocked.mockResolvedValueOnce(true);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ code: 'BLOCKED' }));
    });

    it('rejects when target is in another answered call (busy)', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'u-2', leftAt: null }]);
      mockSafety.isBlocked.mockResolvedValue(false);
      // Simulate target's call lookup
      mockCallState.getUserCallId
        .mockResolvedValueOnce(null)            // initiator's stale call check
        .mockResolvedValueOnce('busy-call');    // target's busy check
      mockCallState.getCall.mockResolvedValueOnce({
        callId: 'busy-call', answeredAt: new Date(),
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:busy',
        expect.objectContaining({ code: 'BUSY' }));
    });

    it('rejects when all targets have left the conversation', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([
        { userId: 'u-2', leftAt: new Date() },
      ]);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ code: 'TARGET_NOT_PARTICIPANT' }));
    });

    it('rejects when target has no devices registered', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'u-2', leftAt: null }]);
      (mockPrisma as any).voipToken = { count: vi.fn().mockResolvedValue(0) };
      (mockPrisma as any).fcmToken = { count: vi.fn().mockResolvedValue(0) };
      const io = makeIO();
      io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:initiate']({ conversationId: 'c-1', targetUserIds: ['u-2'] });
      expect(socket.emit).toHaveBeenCalledWith('call:unavailable', expect.any(Object));
    });

    it('happy path: emits call:initiated', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      mockPrisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'u-2', leftAt: null }]);
      mockSafety.isBlocked.mockResolvedValue(false);
      (mockPrisma as any).voipToken = { count: vi.fn().mockResolvedValue(1) };
      (mockPrisma as any).fcmToken = { count: vi.fn().mockResolvedValue(1) };
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Caller', avatarUrl: null });
      (mockPrisma as any).user.findMany = vi.fn().mockResolvedValue([
        { id: 'user-1', displayName: 'Caller', avatarUrl: null },
        { id: 'u-2', displayName: 'Bob', avatarUrl: null },
      ]);
      const io = makeIO();
      io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:initiate']({
        conversationId: 'c-1',
        targetUserIds: ['u-2'],
        callType: 'AUDIO',
      });
      expect(socket.emit).toHaveBeenCalledWith('call:initiated', expect.any(Object));
      expect(mockCallState.addCall).toHaveBeenCalled();
    });

    it('happy path: skips block check for group calls', async () => {
      mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Caller', avatarUrl: null });
      (mockPrisma as any).user.findMany = vi.fn().mockResolvedValue([]);
      const io = makeIO();
      io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([{}]) }));
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:initiate']({
        conversationId: 'c-1',
        targetUserIds: ['u-2', 'u-3'],
        isGroup: true,
        callType: 'VIDEO',
      });
      expect(mockSafety.isBlocked).not.toHaveBeenCalled();
    });
  });

  describe('call:ringing', () => {
    it('marks ringing acked when active call exists', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        answeredAt: null,
        initiatorId: 'init-1',
        participantIds: new Set(['user-1']),
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:ringing']({ callId: 'c-1' });
      expect(mockCallState.markRinging).toHaveBeenCalledWith('c-1', 'user-1');
    });

    it('no-op when call not found', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:ringing']({ callId: 'c-1' });
      expect(mockCallState.markRinging).not.toHaveBeenCalled();
    });
  });

  describe('call:request-token', () => {
    it('returns LiveKit token to group call participant', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        participantIds: new Set(['user-1']),
        isGroup: true,
      });
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:request-token']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:livekit-token', expect.objectContaining({
        token: 'jwt-token',
      }));
    });

    it('rejects when call not found', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:request-token']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:error', expect.any(Object));
    });

    it('rejects when user not a participant', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        participantIds: new Set(['other']),
        isGroup: true,
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:request-token']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:error', expect.any(Object));
    });

    it('rejects when call is not group', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        participantIds: new Set(['user-1']),
        isGroup: false,
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:request-token']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:error', expect.any(Object));
    });
  });

  describe('call:reaction', () => {
    it('emits reaction to other participants', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        participantIds: new Set(['user-1', 'user-2']),
      });
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:reaction']({ callId: 'c-1', emoji: '🎉' });
      expect(socket.to).toHaveBeenCalledWith('call:c-1');
    });

    it('no-op when missing callId or emoji', async () => {
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:reaction']({ callId: '', emoji: '🎉' });
      expect(socket.to).not.toHaveBeenCalled();
    });

    it('no-op when call not found', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:reaction']({ callId: 'c-1', emoji: '🎉' });
      expect(socket.to).not.toHaveBeenCalled();
    });
  });

  describe('call:answer', () => {
    it('rejects when call not found', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:answer']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:error', expect.any(Object));
    });

    it('rejects when not a participant', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', participantIds: new Set(['other']),
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:answer']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:error', expect.any(Object));
    });

    it('1-on-1: rejects second answer', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', initiatorId: 'init',
        participantIds: new Set(['user-1']),
        isGroup: false,
      });
      mockCallState.markAnswered.mockResolvedValueOnce(false);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:answer']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:error',
        expect.objectContaining({ code: 'ALREADY_ANSWERED' }));
    });

    it('answers and emits call:answered + livekit-token', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', initiatorId: 'init',
        participantIds: new Set(['user-1']),
        isGroup: false,
        answeredAt: null,
      });
      mockCallState.markAnswered.mockResolvedValueOnce(true);
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:answer']({ callId: 'c-1' });
      expect(socket.emit).toHaveBeenCalledWith('call:livekit-token', expect.any(Object));
    });

    it('group: emits call:participant-joined', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', initiatorId: 'init',
        participantIds: new Set(['user-1']),
        isGroup: true,
        answeredAt: null,
      });
      mockCallState.markAnswered.mockResolvedValueOnce(true);
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Alice' });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:answer']({ callId: 'c-1' });
      // After the REST/socket refactor, participant-joined is emitted via
      // `io.to(call:<id>)` (so it works for the REST accept path that has
      // no Socket of its own). The new joiner's socket is added to the
      // room AFTER the emit, so they don't receive their own message.
      expect(io.to).toHaveBeenCalledWith('call:c-1');
    });
  });

  describe('call:reject', () => {
    it('no-op when call missing or not participant', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:reject']({ callId: 'c-1' });
      expect(mockCallState.cleanup).not.toHaveBeenCalled();
    });

    it('1-on-1: cleans up call', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', initiatorId: 'init',
        participantIds: new Set(['user-1']),
        isGroup: false,
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:reject']({ callId: 'c-1' });
      expect(mockCallState.cleanup).toHaveBeenCalledWith('c-1');
    });

    it('1-on-1: skips when termination already claimed', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', initiatorId: 'init',
        participantIds: new Set(['user-1']),
        isGroup: false,
      });
      mockCallState.claimTermination.mockResolvedValueOnce(false);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:reject']({ callId: 'c-1' });
      expect(mockCallState.cleanup).not.toHaveBeenCalled();
    });

    it('group: removes participant', async () => {
      mockCallState.getCall.mockResolvedValueOnce({
        callId: 'c-1', initiatorId: 'init',
        participantIds: new Set(['user-1', 'init', 'other']),
        isGroup: true,
      }).mockResolvedValueOnce({
        callId: 'c-1',
        participantIds: new Set(['init', 'other']),
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:reject']({ callId: 'c-1' });
      expect(mockCallState.removeParticipant).toHaveBeenCalled();
    });
  });

  describe('call:signal', () => {
    it('drops when call missing', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:signal']({ callId: 'c-1', to: 'u-2', type: 'offer' });
      expect(io.to).not.toHaveBeenCalled();
    });

    it('drops when sender not in participants', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', participantIds: new Set(['other']),
      });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:signal']({ callId: 'c-1', to: 'u-2', type: 'offer' });
      expect(io.to).not.toHaveBeenCalled();
    });

    it('drops for group calls (LiveKit handles)', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', participantIds: new Set(['user-1']),
        isGroup: true,
      });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:signal']({ callId: 'c-1', to: 'u-2', type: 'offer' });
      expect(io.to).not.toHaveBeenCalled();
    });

    it('relays to target user for 1-on-1', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', participantIds: new Set(['user-1']),
        isGroup: false,
      });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:signal']({ callId: 'c-1', to: 'u-2', type: 'offer', sdp: 'v=0' });
      expect(io.to).toHaveBeenCalledWith('user:u-2');
    });
  });

  describe('call:end', () => {
    it('no-op when call missing', async () => {
      mockCallState.getCall.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:end']({ callId: 'c-1' });
      expect(mockCallState.cleanup).not.toHaveBeenCalled();
    });

    it('skips when termination already claimed', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1', initiatorId: 'user-1',
        participantIds: new Set(['user-1', 'u-2']),
        answeredAt: new Date(),
      });
      mockCallState.claimTermination.mockResolvedValueOnce(false);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['call:end']({ callId: 'c-1' });
      expect(mockCallState.cleanup).not.toHaveBeenCalled();
    });

    it('cancels ringing on un-answered hangup', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        initiatorId: 'user-1',
        conversationId: 'conv-1',
        callType: 'AUDIO',
        participantIds: new Set(['user-1', 'u-2']),
        answeredAt: null,
      });
      mockPrisma.user.findUnique.mockResolvedValue({ displayName: 'Caller' });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:end']({ callId: 'c-1' });
      expect(io.to).toHaveBeenCalledWith('user:u-2');
      expect(mockCallState.cleanup).toHaveBeenCalled();
    });

    it('ends an active call cleanly', async () => {
      mockCallState.getCall.mockResolvedValue({
        callId: 'c-1',
        initiatorId: 'user-1',
        participantIds: new Set(['user-1']),
        answeredAt: new Date(),
      });
      const io = makeIO();
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(io, socket);
      await handlers['call:end']({ callId: 'c-1' });
      expect(socket.to).toHaveBeenCalledWith('call:c-1');
      expect(mockCallState.cleanup).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('no-op when user not in call', async () => {
      mockCallState.getUserCallId.mockResolvedValue(null);
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['disconnect']();
      // No throw
    });

    it('records disconnect grace when in call', async () => {
      mockCallState.getUserCallId.mockResolvedValue('call-1');
      mockCallState.getCall.mockResolvedValue({
        callId: 'call-1', participantIds: new Set(['user-1']),
        answeredAt: new Date(), initiatorId: 'user-1',
      });
      const { socket, handlers } = makeSocket();
      await registerCallHandlers(makeIO(), socket);
      await handlers['disconnect']();
      expect(mockCallState.setDisconnectGrace).toHaveBeenCalled();
    });

    it('grace expiry: ends call when no live sockets', async () => {
      vi.useFakeTimers();
      try {
        mockCallState.getUserCallId.mockResolvedValue('call-1');
        mockCallState.getCall.mockResolvedValue({
          callId: 'call-1', participantIds: new Set(['user-1']),
          answeredAt: new Date(), initiatorId: 'user-1', isGroup: false,
        });
        const io = makeIO();
        io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
        const { socket, handlers } = makeSocket();
        await registerCallHandlers(io, socket);
        await handlers['disconnect']();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(mockCallState.cleanup).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('grace expiry: skipped when user reconnects on another instance', async () => {
      vi.useFakeTimers();
      try {
        mockCallState.getUserCallId.mockResolvedValue('call-1');
        mockCallState.getCall.mockResolvedValue({
          callId: 'call-1', participantIds: new Set(['user-1']),
          answeredAt: new Date(), initiatorId: 'user-1', isGroup: false,
        });
        const fetchSockets = vi.fn().mockResolvedValue([{}]);
        const io = makeIO();
        io.in = vi.fn(() => ({ fetchSockets }));
        const { socket, handlers } = makeSocket();
        await registerCallHandlers(io, socket);
        await handlers['disconnect']();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(mockCallState.cleanup).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('grace expiry: group call removes participant when >2 left', async () => {
      vi.useFakeTimers();
      try {
        mockCallState.getUserCallId.mockResolvedValue('call-1');
        mockCallState.getCall.mockResolvedValue({
          callId: 'call-1',
          participantIds: new Set(['user-1', 'a', 'b', 'c']),
          answeredAt: new Date(), initiatorId: 'init', isGroup: true,
        });
        const io = makeIO();
        io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) }));
        const { socket, handlers } = makeSocket();
        await registerCallHandlers(io, socket);
        await handlers['disconnect']();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(mockCallState.removeParticipant).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
