import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListUsers, mockGetConversations, mockGetNotifications } = vi.hoisted(() => ({
  mockListUsers: vi.fn(),
  mockGetConversations: vi.fn(),
  mockGetNotifications: vi.fn(),
}));

vi.mock('../../user/user.service', () => ({ listUsers: mockListUsers }));
vi.mock('../../chat/chat.service', () => ({ getConversations: mockGetConversations }));
vi.mock('../../notification/notification.service', () => ({ getNotifications: mockGetNotifications }));

import { koraToolDeclarations, executeTool } from '../tools/kora-tools';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('kora-tools', () => {
  it('exposes 4 tool declarations', () => {
    expect(koraToolDeclarations).toHaveLength(4);
    expect(koraToolDeclarations.map((t) => t.function.name)).toEqual([
      'find_people', 'get_unread_messages', 'get_notifications', 'start_matching',
    ]);
  });

  describe('find_people', () => {
    it('returns suggestions with online count summary', async () => {
      mockListUsers.mockResolvedValue({
        users: [
          { id: 'u-1', displayName: 'Alice', isOnline: true },
          { id: 'u-2', displayName: 'Bob', isOnline: false },
        ],
        page: 1, hasMore: false,
      });
      const res = await executeTool('find_people', { limit: 2 }, 'me');
      expect(res.action.actionType).toBe('user_suggestions');
      expect((res.action.data as any[]).length).toBe(2);
      expect(res.llmContext).toContain('1 currently online');
    });

    it('uses default limit of 5', async () => {
      mockListUsers.mockResolvedValue({ users: [], page: 1, hasMore: false });
      await executeTool('find_people', {}, 'me');
      expect(mockListUsers).toHaveBeenCalledWith('me', 1, 5);
    });
  });

  describe('get_unread_messages', () => {
    it('returns empty when no unread', async () => {
      mockGetConversations.mockResolvedValue([]);
      const res = await executeTool('get_unread_messages', {}, 'me');
      expect(res.action.actionType).toBe('unread_messages');
      expect((res.action.data as any[]).length).toBe(0);
      expect(res.llmContext).toMatch(/no unread/);
    });

    it('summarizes unread per conversation', async () => {
      mockGetConversations.mockResolvedValue([
        {
          id: 'c-1',
          unreadCount: 2,
          participants: [
            { userId: 'me', user: {} },
            { userId: 'u-2', user: { displayName: 'Bob', avatarUrl: null, isOnline: true } },
          ],
          lastMessage: { content: 'hi' },
        },
      ]);
      const res = await executeTool('get_unread_messages', {}, 'me');
      expect((res.action.data as any[])[0].displayName).toBe('Bob');
      expect(res.llmContext).toContain('Bob');
    });
  });

  describe('get_notifications', () => {
    it('returns empty when none', async () => {
      mockGetNotifications.mockResolvedValue([]);
      const res = await executeTool('get_notifications', {}, 'me');
      expect((res.action.data as any[]).length).toBe(0);
      expect(res.llmContext).toMatch(/no unread/);
    });

    it('returns up to 10 unread', async () => {
      const all = Array.from({ length: 15 }, (_, i) => ({
        id: `n-${i}`, type: 'LIKE', title: 't', body: 'b', isRead: false,
        imageUrl: null, data: {}, createdAt: new Date(),
      }));
      mockGetNotifications.mockResolvedValue(all);
      const res = await executeTool('get_notifications', {}, 'me');
      expect((res.action.data as any[]).length).toBe(10);
    });
  });

  it('start_matching returns navigate action', async () => {
    const res = await executeTool('start_matching', {}, 'me');
    expect(res.action.actionType).toBe('navigate');
    expect((res.action.data as any).route).toBe('/matching');
  });

  it('falls back to unknown tool action', async () => {
    const res = await executeTool('not-a-real-tool', {}, 'me');
    expect(res.action.actionType).toBe('unknown');
    expect(res.llmContext).toMatch(/Unknown tool/);
  });
});
