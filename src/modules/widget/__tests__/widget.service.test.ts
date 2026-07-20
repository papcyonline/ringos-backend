import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    widgetConfig: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    webVisitor: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    widgetLead: { create: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    conversation: { create: vi.fn() },
    message: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const { mockSendMessage, mockBroadcast, mockCheckRateLimit } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockBroadcast: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: { WIDGET_PUBLIC_URL: 'https://test.example' } }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../shared/redis.service', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('../../chat/chat.service', () => ({ sendMessage: mockSendMessage }));
vi.mock('../../chat/chat.utils', () => ({ broadcastAndNotifyMessage: mockBroadcast }));

import {
  getPublicConfig,
  updateConfig,
  startSession,
  visitorSendMessage,
  buildEmbedSnippet,
} from '../widget.service';

const liveConfig = {
  id: 'cfg1',
  userId: 'owner1',
  handle: 'abc123',
  enabled: true,
  allowedDomains: ['example.com'],
  theme: null,
  offlineCapture: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetAt: 0 });
  mockPrisma.user.findUnique.mockResolvedValue({ isOnline: true, displayName: 'Owner', avatarUrl: null });
});

describe('widget.service', () => {
  describe('buildEmbedSnippet', () => {
    it('points at WIDGET_PUBLIC_URL with the handle', () => {
      expect(buildEmbedSnippet('h9')).toBe(
        '<script src="https://test.example/widget.js" data-handle="h9" async></script>',
      );
    });
  });

  describe('getPublicConfig — origin gating', () => {
    it('throws when the widget does not exist', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue(null);
      await expect(getPublicConfig('nope', 'example.com')).rejects.toThrow(/not found/i);
    });

    it('throws when the widget is disabled', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue({ ...liveConfig, enabled: false });
      await expect(getPublicConfig('abc123', 'example.com')).rejects.toThrow(/not found/i);
    });

    it('throws when the origin is not allow-listed', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue(liveConfig);
      await expect(getPublicConfig('abc123', 'evil.com')).rejects.toThrow(/not enabled for this website/i);
    });

    it('rejects an empty allow-list (secure default)', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue({ ...liveConfig, allowedDomains: [] });
      await expect(getPublicConfig('abc123', 'example.com')).rejects.toThrow();
    });

    it('allows an exact host and a subdomain', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue(liveConfig);
      await expect(getPublicConfig('abc123', 'example.com')).resolves.toMatchObject({ handle: 'abc123' });
      await expect(getPublicConfig('abc123', 'shop.example.com')).resolves.toMatchObject({ handle: 'abc123' });
    });
  });

  describe('updateConfig', () => {
    it('dedupes allowedDomains before persisting', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue(liveConfig);
      mockPrisma.widgetConfig.update.mockResolvedValue(liveConfig);
      await updateConfig('owner1', { allowedDomains: ['a.com', 'a.com', 'b.com'] });
      expect(mockPrisma.widgetConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ allowedDomains: ['a.com', 'b.com'] }) }),
      );
    });
  });

  describe('startSession', () => {
    it('mints a shadow user + token on first contact', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue(liveConfig);
      mockPrisma.user.create.mockResolvedValue({ id: 'shadow1' });
      mockPrisma.webVisitor.create.mockResolvedValue({ id: 'v1', conversationId: null });

      const res = await startSession({ handle: 'abc123', originHost: 'example.com' });

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isWebVisitor: true, authProvider: 'WIDGET' }),
        }),
      );
      expect(res.visitorId).toBe('v1');
      expect(typeof res.visitorToken).toBe('string');
      expect(res.visitorToken.length).toBeGreaterThan(10);
      expect(res.conversationId).toBeNull();
      expect(res.ownerOnline).toBe(true);
    });

    it('resumes an existing session, keeping the same token', async () => {
      mockPrisma.widgetConfig.findUnique.mockResolvedValue(liveConfig);
      mockPrisma.webVisitor.findUnique.mockResolvedValue({
        id: 'v1', widgetConfigId: 'cfg1', blockedAt: null, conversationId: 'c1',
      });
      mockPrisma.webVisitor.update.mockResolvedValue({});

      const res = await startSession({ handle: 'abc123', originHost: 'example.com', visitorToken: 'existing-token-xyz' });

      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(res.visitorToken).toBe('existing-token-xyz');
      expect(res.conversationId).toBe('c1');
    });
  });

  describe('visitorSendMessage', () => {
    const liveVisitor = {
      id: 'v1',
      shadowUserId: 's1',
      conversationId: null as string | null,
      blockedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      widgetConfigId: 'cfg1',
      widgetConfig: { enabled: true, userId: 'owner1' },
    };

    it('rejects a blocked visitor', async () => {
      mockPrisma.webVisitor.findUnique.mockResolvedValue({ ...liveVisitor, blockedAt: new Date() });
      await expect(visitorSendMessage('tok', 'hi')).rejects.toThrow(/blocked/i);
    });

    it('rejects an expired session', async () => {
      mockPrisma.webVisitor.findUnique.mockResolvedValue({ ...liveVisitor, expiresAt: new Date(Date.now() - 1000) });
      await expect(visitorSendMessage('tok', 'hi')).rejects.toThrow(/expired/i);
    });

    it('lazily creates the conversation, then bridges via sendMessage + broadcast', async () => {
      mockPrisma.webVisitor.findUnique.mockResolvedValue({ ...liveVisitor });
      mockPrisma.conversation.create.mockResolvedValue({ id: 'c1' });
      mockPrisma.webVisitor.update.mockResolvedValue({});
      const message = { id: 'm1', content: 'hi', sender: { displayName: 'Web visitor' } };
      mockSendMessage.mockResolvedValue(message);

      const res = await visitorSendMessage('tok', 'hi', 'client-123');

      expect(mockPrisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'WIDGET' }) }),
      );
      expect(mockSendMessage).toHaveBeenCalledWith('c1', 's1', 'hi', { clientMsgId: 'client-123' });
      expect(mockBroadcast).toHaveBeenCalledWith(message, 'c1', 's1');
      expect(res).toBe(message);
    });

    it('reuses an existing conversation without recreating it', async () => {
      mockPrisma.webVisitor.findUnique.mockResolvedValue({ ...liveVisitor, conversationId: 'existing' });
      mockPrisma.webVisitor.update.mockResolvedValue({});
      mockSendMessage.mockResolvedValue({ id: 'm2', content: 'yo', sender: { displayName: 'x' } });

      await visitorSendMessage('tok', 'yo');

      expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith('existing', 's1', 'yo', { clientMsgId: undefined });
    });
  });
});
