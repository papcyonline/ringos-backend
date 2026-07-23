import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    widgetConfig: { findUnique: vi.fn(), create: vi.fn() },
    widgetTeamMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    conversationParticipant: { createMany: vi.fn(), deleteMany: vi.fn() },
    webVisitor: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

const { mockCreateNotification, mockSendPush } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockSendPush: vi.fn(),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: { WIDGET_PUBLIC_URL: 'https://test.example' } }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../shared/redis.service', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../../chat/chat.service', () => ({ sendMessage: vi.fn() }));
vi.mock('../../chat/chat.utils', () => ({ broadcastAndNotifyMessage: vi.fn() }));
vi.mock('../../notification/notification.service', () => ({
  createNotification: mockCreateNotification,
  sendPushToUser: mockSendPush,
}));

import {
  getPublicConfig,
  inviteTeamMember,
  respondToInvite,
  removeTeamMember,
} from '../widget.service';

const config = {
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
  mockCreateNotification.mockResolvedValue(undefined);
  mockSendPush.mockResolvedValue(undefined);
});

describe('widget team presence', () => {
  it('widget reads "online" when the owner is offline but a teammate is online', async () => {
    mockPrisma.widgetConfig.findUnique.mockResolvedValue(config);
    // owner identity fetch (offline, no recent lastSeen)
    mockPrisma.user.findUnique.mockResolvedValue({
      displayName: 'Owner', avatarUrl: null, isOnline: false,
      lastSeenAt: new Date(Date.now() - 60 * 60 * 1000), isVerified: false,
    });
    // isTeamOnline: one accepted member
    mockPrisma.widgetTeamMember.findMany.mockResolvedValue([{ userId: 'm1' }]);
    mockPrisma.user.findMany.mockResolvedValue([
      { isOnline: false, lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) }, // owner
      { isOnline: true, lastSeenAt: null }, // teammate online
    ]);

    const res = await getPublicConfig('abc123', 'example.com');
    expect(res.owner.online).toBe(true);
  });

  it('widget reads "away" when owner and all teammates are offline', async () => {
    mockPrisma.widgetConfig.findUnique.mockResolvedValue(config);
    mockPrisma.user.findUnique.mockResolvedValue({
      displayName: 'Owner', avatarUrl: null, isOnline: false,
      lastSeenAt: new Date(Date.now() - 60 * 60 * 1000), isVerified: false,
    });
    mockPrisma.widgetTeamMember.findMany.mockResolvedValue([{ userId: 'm1' }]);
    mockPrisma.user.findMany.mockResolvedValue([
      { isOnline: false, lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
      { isOnline: false, lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
    ]);

    const res = await getPublicConfig('abc123', 'example.com');
    expect(res.owner.online).toBe(false);
  });
});

describe('inviteTeamMember', () => {
  it('rejects inviting yourself', async () => {
    await expect(inviteTeamMember('owner1', 'owner1')).rejects.toThrow();
  });

  it('rejects a duplicate invite', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'm1', isWebVisitor: false });
    mockPrisma.widgetConfig.findUnique.mockResolvedValue(config);
    mockPrisma.widgetTeamMember.findUnique.mockResolvedValue({ id: 'tm1' }); // already exists
    await expect(inviteTeamMember('owner1', 'm1')).rejects.toThrow();
  });

  it('creates a pending member and notifies them', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'm1', isWebVisitor: false }) // target
      .mockResolvedValueOnce({ displayName: 'Owner' }); // owner (for notification body)
    mockPrisma.widgetConfig.findUnique.mockResolvedValue(config);
    mockPrisma.widgetTeamMember.findUnique.mockResolvedValue(null);
    mockPrisma.widgetTeamMember.create.mockResolvedValue({ id: 'tm1' });

    const res = await inviteTeamMember('owner1', 'm1');
    expect(res).toEqual({ ok: true });
    expect(mockPrisma.widgetTeamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'm1', status: 'PENDING' }) }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'm1', data: expect.objectContaining({ kind: 'widget_team_invite' }) }),
    );
  });
});

describe('respondToInvite', () => {
  it('accepting marks ACCEPTED and backfills existing conversations', async () => {
    mockPrisma.widgetTeamMember.findUnique.mockResolvedValue({ status: 'PENDING' });
    mockPrisma.widgetTeamMember.update.mockResolvedValue({});
    mockPrisma.webVisitor.findMany.mockResolvedValue([{ conversationId: 'c1' }, { conversationId: 'c2' }]);
    mockPrisma.conversationParticipant.createMany.mockResolvedValue({ count: 2 });

    const res = await respondToInvite('m1', 'cfg1', true);
    expect(res).toEqual({ ok: true, accepted: true });
    expect(mockPrisma.widgetTeamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
    );
    expect(mockPrisma.conversationParticipant.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { conversationId: 'c1', userId: 'm1' },
          { conversationId: 'c2', userId: 'm1' },
        ],
        skipDuplicates: true,
      }),
    );
  });

  it('declining deletes the pending row and does not backfill', async () => {
    mockPrisma.widgetTeamMember.findUnique.mockResolvedValue({ status: 'PENDING' });
    mockPrisma.widgetTeamMember.delete.mockResolvedValue({});

    const res = await respondToInvite('m1', 'cfg1', false);
    expect(res).toEqual({ ok: true, accepted: false });
    expect(mockPrisma.conversationParticipant.createMany).not.toHaveBeenCalled();
  });

  it('rejects responding to a non-pending / missing invite', async () => {
    mockPrisma.widgetTeamMember.findUnique.mockResolvedValue(null);
    await expect(respondToInvite('m1', 'cfg1', true)).rejects.toThrow();
  });
});

describe('removeTeamMember', () => {
  it('deletes membership and strips participant rows from the widget conversations', async () => {
    mockPrisma.widgetConfig.findUnique.mockResolvedValue(config);
    mockPrisma.widgetTeamMember.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.webVisitor.findMany.mockResolvedValue([{ conversationId: 'c1' }]);
    mockPrisma.conversationParticipant.deleteMany.mockResolvedValue({ count: 1 });

    const res = await removeTeamMember('owner1', 'm1');
    expect(res).toEqual({ ok: true });
    expect(mockPrisma.widgetTeamMember.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'm1' }) }),
    );
    expect(mockPrisma.conversationParticipant.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'm1', conversationId: { in: ['c1'] } }) }),
    );
  });
});
