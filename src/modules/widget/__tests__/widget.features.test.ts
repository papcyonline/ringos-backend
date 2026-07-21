import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers the newer widget features: offline-lead delete, image send, read
// receipts, presence, poll read-cursors, and the visitor country flag. Kept in
// its own file so its extra mocks (socket, user presence, upload) don't touch
// the original widget.service.test.ts.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    widgetConfig: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    webVisitor: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(),
      create: vi.fn(), update: vi.fn(),
    },
    widgetLead: { create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    conversation: { create: vi.fn() },
    conversationParticipant: { findFirst: vi.fn() },
    message: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const {
  mockSendMessage, mockBroadcast, mockCheckRateLimit, mockMarkRead,
  mockFileToUrl, mockSetOnline, mockSetOffline, mockEmit, mockTo,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockBroadcast: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockMarkRead: vi.fn(),
  mockFileToUrl: vi.fn(),
  mockSetOnline: vi.fn(),
  mockSetOffline: vi.fn(),
  mockEmit: vi.fn(),
  mockTo: vi.fn(),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: { WIDGET_PUBLIC_URL: 'https://test.example' } }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../shared/redis.service', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('../../chat/chat.service', () => ({
  sendMessage: mockSendMessage,
  markConversationAsRead: mockMarkRead,
}));
vi.mock('../../chat/chat.utils', () => ({ broadcastAndNotifyMessage: mockBroadcast }));
vi.mock('../../../shared/upload', () => ({ fileToChatImageUrl: mockFileToUrl }));
vi.mock('../../notification/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../user/user.service', () => ({ setOnline: mockSetOnline, setOffline: mockSetOffline }));
vi.mock('../../../config/socket', () => ({ getIO: () => ({ to: mockTo }) }));

import {
  deleteLeads,
  visitorSendImage,
  visitorMarkRead,
  visitorGetMessages,
  visitorSendMessage,
  widgetPresenceConnect,
  widgetPresenceDisconnect,
} from '../widget.service';

const TOKEN = 'tok_1234567890abcdef';
const OWNER = 'owner1';
const SHADOW = 'shadow1';
const CONV = 'conv1';

/** A live, unblocked visitor whose token resolves (used by requireVisitor). */
function mockVisitor(over: Record<string, unknown> = {}) {
  mockPrisma.webVisitor.findUnique.mockResolvedValue({
    id: 'v1',
    shadowUserId: SHADOW,
    conversationId: CONV,
    blockedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    country: null, countryCode: null, city: null,
    userAgent: null, pageUrl: null, referrer: null, email: null,
    widgetConfig: { id: 'cfg1', userId: OWNER, enabled: true },
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetAt: 0 });
  mockTo.mockReturnValue({ emit: mockEmit });
  mockPrisma.webVisitor.update.mockResolvedValue({});
  mockSetOnline.mockResolvedValue(undefined);
  mockSetOffline.mockResolvedValue(undefined);
});

describe('deleteLeads', () => {
  it('no-ops (no DB call) on an empty id list', async () => {
    const n = await deleteLeads(OWNER, []);
    expect(n).toBe(0);
    expect(mockPrisma.widgetLead.deleteMany).not.toHaveBeenCalled();
  });

  it('scopes the delete to the owner\'s own widget config', async () => {
    mockPrisma.widgetConfig.findUnique.mockResolvedValue({ id: 'cfg1', userId: OWNER });
    mockPrisma.widgetLead.deleteMany.mockResolvedValue({ count: 2 });
    const n = await deleteLeads(OWNER, ['a', 'b']);
    expect(n).toBe(2);
    expect(mockPrisma.widgetLead.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, widgetConfigId: 'cfg1' },
    });
  });
});

describe('visitorSendImage', () => {
  it('uploads to R2 then bridges the image message to the owner', async () => {
    mockVisitor();
    mockFileToUrl.mockResolvedValue('https://cdn/x.jpg');
    mockSendMessage.mockResolvedValue({ id: 'm1', imageUrl: 'https://cdn/x.jpg' });
    const file = { buffer: Buffer.from('x'), mimetype: 'image/jpeg' } as never;

    const msg = await visitorSendImage(TOKEN, file, 'hi');

    expect(mockFileToUrl).toHaveBeenCalledWith(file, CONV);
    expect(mockSendMessage).toHaveBeenCalledWith(CONV, SHADOW, 'hi', { imageUrl: 'https://cdn/x.jpg' });
    expect(mockBroadcast).toHaveBeenCalledWith(msg, CONV, SHADOW);
  });

  it('is rate-limited like a text message', async () => {
    mockVisitor();
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0 });
    await expect(visitorSendImage(TOKEN, {} as never)).rejects.toThrow(/slow down/i);
    expect(mockFileToUrl).not.toHaveBeenCalled();
  });
});

describe('visitorMarkRead', () => {
  it('advances the shadow user\'s read cursor and emits chat:read to the owner', async () => {
    mockVisitor();
    mockMarkRead.mockResolvedValue(undefined);
    await visitorMarkRead(TOKEN);
    expect(mockMarkRead).toHaveBeenCalledWith(CONV, SHADOW);
    expect(mockTo).toHaveBeenCalledWith(`user:${OWNER}`);
    expect(mockEmit).toHaveBeenCalledWith('chat:read', { conversationId: CONV, userId: SHADOW });
  });

  it('is a no-op before a conversation exists', async () => {
    mockVisitor({ conversationId: null });
    await visitorMarkRead(TOKEN);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });
});

describe('visitorGetMessages', () => {
  it('returns the owner read/delivered cursors and tags fromVisitor', async () => {
    mockVisitor();
    const read = new Date('2026-01-01T00:00:00Z');
    const delivered = new Date('2026-01-02T00:00:00Z');
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ lastReadAt: read, lastDeliveredAt: delivered });
    mockPrisma.message.findMany.mockResolvedValue([
      { id: 'm1', content: 'hi', createdAt: read, senderId: SHADOW, imageUrl: null },
      { id: 'm2', content: 'yo', createdAt: read, senderId: OWNER, imageUrl: null },
    ]);
    const res = await visitorGetMessages(TOKEN);
    expect(res.ownerReadAt).toBe(read);
    expect(res.ownerDeliveredAt).toBe(delivered);
    expect(res.messages[0]).toMatchObject({ id: 'm1', fromVisitor: true });
    expect(res.messages[1]).toMatchObject({ id: 'm2', fromVisitor: false });
  });
});

describe('presence', () => {
  it('emits user:online only on the first stream and user:offline after the last closes', async () => {
    vi.useFakeTimers();
    try {
      // two concurrent tabs → one online emit
      await widgetPresenceConnect(SHADOW, OWNER);
      await widgetPresenceConnect(SHADOW, OWNER);
      const onlineEmits = mockEmit.mock.calls.filter((c) => c[0] === 'user:online');
      expect(onlineEmits).toHaveLength(1);

      // first tab closes → still present, no offline yet
      widgetPresenceDisconnect(SHADOW, OWNER);
      vi.advanceTimersByTime(9000);
      expect(mockEmit.mock.calls.some((c) => c[0] === 'user:offline')).toBe(false);

      // last tab closes → offline after the grace window
      widgetPresenceDisconnect(SHADOW, OWNER);
      vi.advanceTimersByTime(9000);
      expect(mockEmit.mock.calls.some((c) => c[0] === 'user:offline')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('visitor country flag', () => {
  it('renders the country flag in the opening context message', async () => {
    mockVisitor({ conversationId: null, countryCode: 'GB', country: 'United Kingdom' });
    mockPrisma.conversation.create.mockResolvedValue({ id: CONV });
    mockPrisma.message.create.mockResolvedValue({ id: 'sys1' });
    mockSendMessage.mockResolvedValue({ id: 'm1' });

    await visitorSendMessage(TOKEN, 'hello');

    const sysCall = mockPrisma.message.create.mock.calls.find(
      (c) => c[0]?.data?.isSystem,
    );
    expect(sysCall).toBeTruthy();
    expect(sysCall![0].data.content).toContain('🇬🇧');
    expect(sysCall![0].data.content).toContain('United Kingdom');
  });
});
