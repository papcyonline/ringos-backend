import { describe, it, expect, vi, beforeEach } from 'vitest';

// These tests verify the exact APNs/FCM payload shapes produced by
// notification.service.ts. They are regression tests for:
//
//   1. The iOS lock-screen bug fix: "content-available": 1 must NOT appear
//      in alert pushes — iOS throttles/drops those when the app has been
//      force-quit, which prevented chat / missed-call notifications from
//      displaying on locked screens.
//
//   2. VoIP push routing: iOS devices receive calls via sendVoipPush
//      (PushKit → CallKit) and MUST NOT also receive an FCM alert push,
//      otherwise a duplicate banner would stack on top of the CallKit ring.
//
//   3. Android data-only dispatch: chat/voice-note pushes must omit the
//      `android.notification` field so YomeetFirebaseMessagingService can
//      render MessagingStyle notifications natively (wake-lock, heads-up,
//      channels).
//
// We mock firebase-admin and capture the MulticastMessage, then assert
// on its structure directly.

const { mockPrisma, mockIO, mockSocketRoom, mockSendEachForMulticast, mockSendVoipPush } = vi.hoisted(() => {
  const mockSocketRoom = {
    fetchSockets: vi.fn().mockResolvedValue([]),
  };

  const mockIO = {
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    in: vi.fn().mockReturnValue(mockSocketRoom),
  };

  const mockPrisma = {
    notification: {
      create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    },
    conversationParticipant: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ avatarUrl: null, isVerified: false }),
    },
    fcmToken: {
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    voipToken: {
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const mockSendEachForMulticast = vi.fn().mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    responses: [{ success: true }],
  });

  const mockSendVoipPush = vi.fn().mockResolvedValue({ success: true });

  return { mockPrisma, mockIO, mockSocketRoom, mockSendEachForMulticast, mockSendVoipPush };
});

vi.mock('../../../config/env', () => ({
  env: { CORS_ORIGIN: '*', REDIS_URL: '' },
}));

vi.mock('../../../config/database', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../../config/socket', () => ({
  getIO: () => mockIO,
}));

// Truthy so sendDataPushToUser / sendPushToUser proceed to dispatch.
vi.mock('../../../config/firebase', () => ({
  getFirebaseApp: () => ({ name: 'test-app' }),
}));

vi.mock('../../../config/apns', () => ({
  sendVoipPush: mockSendVoipPush,
}));

vi.mock('firebase-admin', () => ({
  default: {
    messaging: () => ({
      sendEachForMulticast: mockSendEachForMulticast,
    }),
  },
  messaging: () => ({
    sendEachForMulticast: mockSendEachForMulticast,
  }),
}));

import {
  notifyChatMessage,
  sendMissedCallNotification,
  sendCallPush,
  sendCallCancelPush,
  sendPostPush,
} from '../notification.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockSocketRoom.fetchSockets.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue({ avatarUrl: null, isVerified: false });
  mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });
  mockPrisma.fcmToken.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.voipToken.deleteMany.mockResolvedValue({ count: 0 });
  mockSendEachForMulticast.mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    responses: [{ success: true }],
  });
  mockSendVoipPush.mockResolvedValue({ success: true });
});

// Helper: flush microtasks so fire-and-forget `.catch(...)` chains settle
// before the assertion runs.
const tick = () => new Promise((r) => setImmediate(r));

describe('notification.service — APNs payload regression (iOS lock screen bug)', () => {
  it('sendDataPushToUser (chat message) must NOT include content-available', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-ios-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hey there!', {
      messageId: 'm-1',
    });
    await tick();

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
    const msg = mockSendEachForMulticast.mock.calls[0][0];

    // The regression guard.
    expect(msg.apns.payload.aps).not.toHaveProperty('content-available');

    // And the shape we DO want.
    expect(msg.apns.headers).toEqual({
      'apns-priority': '10',
      'apns-push-type': 'alert',
    });
    expect(msg.apns.payload.aps.alert).toEqual({
      title: 'Alice',
      body: 'Hey there!',
    });
    expect(msg.apns.payload.aps.sound).toBe('default');
    expect(msg.apns.payload.aps['mutable-content']).toBe(1);
  });

  it('sendDataPushToUser sends Android as data-only (no android.notification)', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-android-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi!', { messageId: 'm-1' });
    await tick();

    const msg = mockSendEachForMulticast.mock.calls[0][0];
    expect(msg.android).toEqual({ priority: 'high' });
    expect(msg.android.notification).toBeUndefined();
    // Data-only payload carries the type for the native Kotlin handler to route on.
    expect(msg.data.type).toBe('chat_message');
  });

  it('sendPushToUser (missed-call path) must NOT include content-available either', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-ios-2' }]);

    sendMissedCallNotification('recipient-1', {
      callId: 'call-1',
      conversationId: 'conv-1',
      callType: 'AUDIO',
      callerId: 'caller-1',
      callerName: 'Charlie',
    });
    await tick();

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
    const msg = mockSendEachForMulticast.mock.calls[0][0];
    expect(msg.apns.payload.aps).not.toHaveProperty('content-available');
    expect(msg.apns.payload.aps.alert).toEqual({
      title: 'Charlie',
      body: 'Missed call from Charlie',
    });
    expect(msg.apns.payload.aps['mutable-content']).toBe(1);
    // badge must NOT be hardcoded to 1 — it would overwrite the real unread
    // count on the iOS lock-screen when the app is killed. Badge is managed
    // client-side (setIOSBadge) on app resume instead.
    expect(msg.apns.payload.aps).not.toHaveProperty('badge');
    expect(msg.apns.payload.aps.sound).toBe('default');
  });

  it('voice-note push body includes duration when available', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'ignored', {
      messageId: 'm-1',
      audioUrl: 'https://cdn.example.com/v.m4a',
      audioDuration: 9,
    });
    await tick();

    const msg = mockSendEachForMulticast.mock.calls[0][0];
    expect(msg.data.type).toBe('voice_note');
    expect(msg.data.audioUrl).toBe('https://cdn.example.com/v.m4a');
    expect(msg.data.audioDuration).toBe('9');
    // Matches Android's native format (YomeetFirebaseMessagingService.kt).
    expect(msg.apns.payload.aps.alert.body).toBe('\u{1F3A4} Voice message (9s)');
  });

  it('voice-note push body omits duration when audioDuration is 0 or missing', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'ignored', {
      messageId: 'm-1',
      audioUrl: 'https://cdn.example.com/v.m4a',
      // audioDuration omitted
    });
    await tick();

    const msg = mockSendEachForMulticast.mock.calls[0][0];
    expect(msg.apns.payload.aps.alert.body).toBe('\u{1F3A4} Voice message');
  });
});

describe('notification.service — mute & in-room push skip', () => {
  it('permanently muted user: in-app notification created, push skipped', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'muted-user', isMuted: true, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-muted' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    // In-app record is still created so the badge/bell stays accurate.
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    // But no push was dispatched.
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });

  it('time-muted user (mutedUntil in the future): push skipped', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'u', isMuted: false, mutedUntil: new Date(Date.now() + 60_000) },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });

  it('time-muted user (mutedUntil in the past): push still sent', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'u', isMuted: false, mutedUntil: new Date(Date.now() - 60_000) },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it('user actively in the conversation socket room: push skipped, in-app still created', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'in-room', isMuted: false, mutedUntil: null },
    ]);
    mockSocketRoom.fetchSockets.mockResolvedValue([{ userId: 'in-room' }]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-1' }]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });
});

describe('notification.service — sendCallPush routing', () => {
  it('FCM goes to Android devices only; VoIP goes to iOS separately', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-android-1' }]);
    mockPrisma.voipToken.findMany.mockResolvedValue([{ token: 'voip-ios-1' }]);

    await sendCallPush('target-1', {
      callId: 'call-1',
      conversationId: 'conv-1',
      callType: 'VIDEO',
      callerId: 'caller-1',
      callerName: 'Dana',
      isGroup: false,
    });
    await tick();

    // The Android FCM query is filtered by platform.
    const fcmFindCall = mockPrisma.fcmToken.findMany.mock.calls.find(
      (c: any[]) => c[0]?.where?.platform === 'android',
    );
    expect(fcmFindCall).toBeDefined();

    // FCM fires with call payload + high priority + 60s TTL.
    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
    const fcmMsg = mockSendEachForMulticast.mock.calls[0][0];
    expect(fcmMsg.data.type).toBe('incoming_call');
    expect(fcmMsg.data.callId).toBe('call-1');
    expect(fcmMsg.android).toEqual({ priority: 'high', ttl: 60000 });
    // Crucially, no apns block — iOS must NOT get the FCM alert for calls.
    expect(fcmMsg.apns).toBeUndefined();

    // VoIP fires once per iOS VoIP token with the same call data.
    expect(mockSendVoipPush).toHaveBeenCalledTimes(1);
    const [voipToken, voipPayload] = mockSendVoipPush.mock.calls[0];
    expect(voipToken).toBe('voip-ios-1');
    expect(voipPayload).toMatchObject({
      callId: 'call-1',
      callType: 'VIDEO',
      callerName: 'Dana',
    });
  });

  it('deletes VoIP token when APNs returns 410 (unregistered)', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([]);
    mockPrisma.voipToken.findMany.mockResolvedValue([{ token: 'voip-dead' }]);
    mockSendVoipPush.mockResolvedValue({ success: false, unregistered: true });

    await sendCallPush('target-1', {
      callId: 'c', conversationId: 'c', callType: 'AUDIO',
      callerId: 'u', callerName: 'E',
    });
    await tick();
    await tick(); // extra flush — the cleanup .then() is one promise deeper

    expect(mockPrisma.voipToken.deleteMany).toHaveBeenCalledWith({
      where: { token: 'voip-dead' },
    });
  });
});

describe('notification.service — sendCallCancelPush', () => {
  it('sends a VoIP payload with cancel: true', async () => {
    mockPrisma.voipToken.findMany.mockResolvedValue([{ token: 'voip-1' }]);

    await sendCallCancelPush('user-1', 'call-abc');
    await tick();

    expect(mockSendVoipPush).toHaveBeenCalledTimes(1);
    const [, payload] = mockSendVoipPush.mock.calls[0];
    expect(payload).toMatchObject({
      callId: 'call-abc',
      cancel: true,
    });
  });

  it('silently no-ops when the user has no VoIP tokens', async () => {
    mockPrisma.voipToken.findMany.mockResolvedValue([]);

    await sendCallCancelPush('user-1', 'call-abc');
    await tick();

    expect(mockSendVoipPush).not.toHaveBeenCalled();
  });
});

describe('notification.service — sendMissedCallNotification', () => {
  it('creates an in-app notification of type MISSED_CALL', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([]);

    sendMissedCallNotification('recipient-1', {
      callId: 'c', conversationId: 'conv-1', callType: 'VIDEO',
      callerId: 'caller-1', callerName: 'Frank',
    });
    await tick();

    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'MISSED_CALL',
        title: 'Frank',
        body: 'Missed video call from Frank',
      }),
    });
  });

  it('uses "Missed call" (no video qualifier) for audio calls', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([]);

    sendMissedCallNotification('recipient-1', {
      callId: 'c', conversationId: 'conv-1', callType: 'AUDIO',
      callerId: 'caller-1', callerName: 'Gina',
    });
    await tick();

    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        body: 'Missed call from Gina',
      }),
    });
  });
});

describe('notification.service — sendPostPush', () => {
  it('sends alert push with the caller-provided data field and no content-available', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'fcm-1' }]);

    await sendPostPush('author-1', {
      title: 'New post',
      body: 'Check this out',
      imageUrl: 'https://cdn.example.com/p.jpg',
      data: { type: 'new_post', postId: 'p-1' },
    });
    await tick();

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
    const msg = mockSendEachForMulticast.mock.calls[0][0];
    expect(msg.apns.payload.aps).not.toHaveProperty('content-available');
    expect(msg.apns.payload.aps.alert).toEqual({
      title: 'New post',
      body: 'Check this out',
    });
    expect(msg.data).toEqual({ type: 'new_post', postId: 'p-1' });
    // Android path includes the notification field so the OS displays it
    // directly (posts don't need the custom native rendering chat does).
    expect(msg.android.notification).toEqual(
      expect.objectContaining({
        channelId: 'yomeet_messages',
        title: 'New post',
        body: 'Check this out',
        imageUrl: 'https://cdn.example.com/p.jpg',
      }),
    );
  });
});

describe('notification.service — invalid token cleanup', () => {
  it('deletes tokens whose FCM send failed with invalid-registration-token', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([
      { token: 'valid' },
      { token: 'dead' },
    ]);
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
      ],
    });

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockPrisma.fcmToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['dead'] } },
    });
  });

  it('deletes tokens on registration-token-not-registered as well', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'dead' }]);
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
      ],
    });

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockPrisma.fcmToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['dead'] } },
    });
  });

  it('does NOT delete tokens for transient errors (e.g. internal-error)', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([{ token: 'flaky' }]);
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    });

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockPrisma.fcmToken.deleteMany).not.toHaveBeenCalled();
  });
});

describe('notification.service — early exits', () => {
  it('sendCallPush no-ops when user has neither FCM nor VoIP tokens', async () => {
    mockPrisma.fcmToken.findMany.mockResolvedValue([]);
    mockPrisma.voipToken.findMany.mockResolvedValue([]);

    await sendCallPush('ghost-user', {
      callId: 'c', conversationId: 'c', callType: 'AUDIO',
      callerId: 'u', callerName: 'n',
    });
    await tick();

    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
    expect(mockSendVoipPush).not.toHaveBeenCalled();
  });

  it('notifyChatMessage skips push dispatch entirely when no FCM tokens exist', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false, mutedUntil: null },
    ]);
    mockPrisma.fcmToken.findMany.mockResolvedValue([]);

    await notifyChatMessage('conv-1', 'sender-1', 'Alice', 'Hi', { messageId: 'm-1' });
    await tick();

    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
  });
});
