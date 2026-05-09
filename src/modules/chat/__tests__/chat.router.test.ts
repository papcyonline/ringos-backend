import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockChatService, mockGroupService, mockPollService, mockChatUtils, mockFolderService, mockNotifService, mockPrisma } = vi.hoisted(() => {
  const success = (val: any = {}) => vi.fn().mockResolvedValue(val);
  return {
    mockChatService: {
      getConversation: success({ id: 'c-1' }),
      getConversations: success([]),
      markConversationAsRead: success({}),
      getOrCreateDirectConversation: success({ id: 'c-1' }),
      getOrCreateChannelDM: success({ id: 'c-dm' }),
      getChannelInbox: success({ items: [], hasMore: false }),
      getChannelInboxUnreadCount: success({ count: 0 }),
      blockChannelSubscriber: success({ blocked: true }),
      deleteChannelDM: success({ deleted: true }),
      sendMessage: success({ id: 'm-1', conversationId: 'c-1', senderId: 'user-1', createdAt: new Date(), content: 'hi' }),
      editMessage: success({ id: 'm-1' }),
      deleteMessage: success({ id: 'm-1', conversationId: 'c-1' }),
      togglePinMessage: success({ id: 'm-1' }),
      getPinnedMessages: success([]),
      openViewOnce: success({ messageId: 'm-1', conversationId: 'c-1' }),
      toggleReaction: success({ action: 'added', emoji: '❤️', messageId: 'm-1', userId: 'user-1', conversationId: 'c-1' }),
      endConversation: success({ id: 'c-1' }),
      getAllGroups: success([]),
      getAllChannels: success([]),
      getRecommendedChannels: success([]),
      searchChannels: success([]),
      getMessages: success({ data: [], page: 1, limit: 50, hasMore: false, nextCursor: null }),
      getMessagesSince: success({ messages: [], hasMore: false, nextSinceId: null, sinceNotFound: false }),
      togglePin: success({ isPinned: true }),
      toggleMute: success({ isMuted: true, mutedUntil: null }),
      setMute: success({ isMuted: true, mutedUntil: null }),
      toggleArchive: success({ isArchived: true }),
      setDisappearingMessages: success({ id: 'c-1', disappearAfterSecs: null, systemMessage: { id: 'sys' } }),
      forwardMessage: success({ id: 'fwd-1' }),
      forwardMessageToMany: success([{ id: 'fwd-1' }]),
      getMessageInfo: success([]),
      searchMessagesGlobal: success([]),
      searchMessages: success([]),
      clearHistory: success({}),
      sendGif: success({ id: 'm-gif' }),
      MAX_FORWARD_TARGETS: 5,
    },
    mockGroupService: {
      createGroup: success({ id: 'c-1' }),
      updateGroup: success({ id: 'c-1' }),
      addMembers: success({ id: 'c-1' }),
      removeMember: success({ removedUserId: 'u-2' }),
      deleteGroup: success({ deleted: true }),
      joinGroup: success({ id: 'c-1' }),
      toggleGroupVerified: success({ id: 'c-1' }),
      updateGroupCallSettings: success({ id: 'c-1' }),
      makeAdmin: success({ id: 'c-1' }),
      checkNameAvailable: success(true),
      demoteAdmin: success({ demotedUserId: 'u-2' }),
      generateInviteCode: success({ inviteCode: 'CODE' }),
      revokeInviteCode: success({ success: true }),
      joinViaInviteCode: success({ id: 'c-1' }),
      updateGroupAdminSettings: success({ id: 'c-1' }),
      banMember: success({ bannedUserId: 'u-2' }),
      unbanMember: success({ unbannedUserId: 'u-2' }),
    },
    mockPollService: {
      createPoll: success({ id: 'p-1' }),
      getPollDetails: success({ id: 'p-1', options: [] }),
      vote: success({ id: 'p-1' }),
      closePoll: success({ id: 'p-1', closedAt: new Date() }),
    },
    mockChatUtils: {
      formatMessagePayload: vi.fn((msg: any) => msg),
      emitToParticipantRooms: vi.fn(),
      broadcastAndNotifyMessage: vi.fn(),
    },
    mockFolderService: {
      getFolders: success([]),
      createFolder: success({ id: 'f-1' }),
      updateFolder: success({ id: 'f-1' }),
      deleteFolder: success({ deleted: true }),
      reorderFolders: success({ success: true }),
      addConversationToFolder: success({ folderId: 'f-1', conversationId: 'c-1' }),
      removeConversationFromFolder: success({ removed: true }),
    },
    mockNotifService: {
      notifyChatMessage: vi.fn(),
      markConversationNotificationsAsRead: vi.fn().mockResolvedValue(undefined),
    },
    mockPrisma: {
      conversation: { findUnique: vi.fn().mockResolvedValue({ id: 'c-1', participants: [{ userId: 'user-1' }] }) },
      conversationParticipant: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'user-1' }, { userId: 'u-2' }]),
        findUnique: vi.fn().mockResolvedValue({ leftAt: null }),
        update: vi.fn().mockResolvedValue({}),
      },
      message: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ hideReadReceipts: false, displayName: 'Alice' }) },
    },
  };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../config/socket', () => ({
  getIO: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() })),
}));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../../../middleware/validate', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../middleware/userRateLimit', () => ({
  userRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../shared/upload', () => {
  const fakeFile = {
    buffer: Buffer.from('x'),
    originalname: 'a.jpg',
    mimetype: 'image/jpeg',
    fieldname: 'file',
    size: 1,
  };
  const fakeUpload = {
    single: () => (req: any, _res: any, next: any) => {
      req.file = { ...fakeFile };
      next();
    },
    array: () => (req: any, _res: any, next: any) => {
      req.files = [{ ...fakeFile }];
      next();
    },
    fields: () => (req: any, _res: any, next: any) => {
      // Populate every field name our routes care about — the same
      // fakeUpload is reused by chatVideoUpload (`video` + `thumbnail`)
      // and chatDocumentUpload (`document` + `thumbnail`).
      req.files = {
        video: [{ ...fakeFile, mimetype: 'video/mp4' }],
        document: [{ ...fakeFile, mimetype: 'application/pdf' }],
        thumbnail: [{ ...fakeFile }],
      };
      next();
    },
  };
  return {
    avatarUpload: fakeUpload,
    chatImageUpload: fakeUpload,
    chatAudioUpload: fakeUpload,
    chatDocumentUpload: fakeUpload,
    chatVideoUpload: fakeUpload,
    fileToAvatarUrl: vi.fn().mockResolvedValue('https://cdn/x.jpg'),
    fileToChatImageUrl: vi.fn().mockResolvedValue('https://cdn/img.jpg'),
    fileToChatAudioUrl: vi.fn().mockResolvedValue('https://cdn/aud.m4a'),
    fileToChatDocumentUrl: vi.fn().mockResolvedValue('https://cdn/doc.pdf'),
    fileToChatVideoUrl: vi.fn().mockResolvedValue('https://cdn/vid.mp4'),
    fileToChatVideoThumbnailUrl: vi.fn().mockResolvedValue('https://cdn/thumb.jpg'),
  };
});
vi.mock('../chat.schema', () => ({
  sendMessageSchema: {},
  editMessageSchema: {},
  reactMessageSchema: {},
  forwardMessageSchema: {},
  searchMessagesSchema: {},
}));
vi.mock('../chat.service', () => mockChatService);
vi.mock('../group.service', () => mockGroupService);
vi.mock('../poll.service', () => mockPollService);
vi.mock('../chat.utils', () => mockChatUtils);
vi.mock('../folder.service', () => mockFolderService);
vi.mock('../streak.service', () => ({ getStreak: vi.fn().mockResolvedValue({ count: 0, isActive: false }) }));
vi.mock('../translation.service', () => ({ translateMessage: vi.fn().mockResolvedValue({ text: 'hello' }) }));
vi.mock('../transcription.service', () => ({ transcribeMessage: vi.fn().mockResolvedValue({ text: 'hi' }) }));
vi.mock('../../notification/notification.service', () => mockNotifService);

import { chatRouter } from '../chat.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default impls after clearAllMocks
  mockChatUtils.formatMessagePayload.mockImplementation((msg: any) => msg);
});

const acceptOk = (status: number) => [200, 201, 204].includes(status);

describe('chat.router (smoke tests)', () => {
  it('GET /chat/conversations', async () => {
    const res = await request(makeApp()).get('/chat/conversations');
    expect(res.status).toBe(200);
  });

  it('GET /chat/conversations/groups/public', async () => {
    const res = await request(makeApp()).get('/chat/conversations/groups/public');
    expect(res.status).toBe(200);
  });

  it('GET /chat/conversations/channels/public', async () => {
    const res = await request(makeApp()).get('/chat/conversations/channels/public');
    expect(res.status).toBe(200);
  });

  it('GET /chat/conversations/channels/recommended', async () => {
    const res = await request(makeApp()).get('/chat/conversations/channels/recommended');
    expect(res.status).toBe(200);
  });

  it('GET /chat/conversations/:id', async () => {
    const res = await request(makeApp()).get('/chat/conversations/c-1');
    expect(res.status).toBe(200);
  });

  it('GET /chat/conversations/:id/messages', async () => {
    const res = await request(makeApp()).get('/chat/conversations/c-1/messages');
    expect(res.status).toBe(200);
  });

  it('POST /chat/conversations/:id/messages', async () => {
    const res = await request(makeApp()).post('/chat/conversations/c-1/messages').send({ content: 'hi' });
    expect(acceptOk(res.status)).toBe(true);
  });

  it('PUT /chat/conversations/:id/messages/:mid', async () => {
    const res = await request(makeApp()).put('/chat/conversations/c-1/messages/m-1').send({ content: 'edited' });
    expect(acceptOk(res.status)).toBe(true);
  });

  it('DELETE /chat/conversations/:id/messages/:mid', async () => {
    const res = await request(makeApp()).delete('/chat/conversations/c-1/messages/m-1?mode=everyone');
    expect(acceptOk(res.status)).toBe(true);
  });

  it('POST /chat/conversations/:id/messages/:mid/reactions', async () => {
    const res = await request(makeApp()).post('/chat/conversations/c-1/messages/m-1/reactions').send({ emoji: '❤️' });
    expect(acceptOk(res.status)).toBe(true);
  });

  it('PATCH /chat/conversations/:id/messages/:mid/pin', async () => {
    const res = await request(makeApp()).patch('/chat/conversations/c-1/messages/m-1/pin');
    expect(acceptOk(res.status)).toBe(true);
  });

  it('GET /chat/conversations/:id/pinned', async () => {
    const res = await request(makeApp()).get('/chat/conversations/c-1/pinned');
    expect(res.status).toBe(200);
  });

  it('POST /chat/conversations/:id/messages/:mid/view-once', async () => {
    const res = await request(makeApp()).post('/chat/conversations/c-1/messages/m-1/view-once');
    expect(acceptOk(res.status)).toBe(true);
  });

  it('POST /chat/conversations/group (create group)', async () => {
    const res = await request(makeApp()).post('/chat/conversations/group').send({ name: 'G', memberIds: [] });
    expect(acceptOk(res.status)).toBe(true);
  });

  it('POST /chat/conversations/:id/join', async () => {
    const res = await request(makeApp()).post('/chat/conversations/c-1/join');
    expect(acceptOk(res.status)).toBe(true);
  });

  it('GET /chat/conversations/group/check-name', async () => {
    const res = await request(makeApp()).get('/chat/conversations/group/check-name?name=foo');
    expect(res.status).toBe(200);
  });

  it('POST /chat/conversations/channel-dm/:channelId', async () => {
    const res = await request(makeApp()).post('/chat/conversations/channel-dm/chan-1');
    expect(acceptOk(res.status)).toBe(true);
  });

  it('GET /chat/conversations/channel-inbox/:channelId', async () => {
    const res = await request(makeApp()).get('/chat/conversations/channel-inbox/chan-1');
    expect(res.status).toBe(200);
  });

  it('GET /chat/conversations/channel-inbox/:channelId/unread-count', async () => {
    const res = await request(makeApp()).get('/chat/conversations/channel-inbox/chan-1/unread-count');
    expect(res.status).toBe(200);
  });

  it('error path: service throws 500', async () => {
    mockChatService.getConversations.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/chat/conversations');
    expect(res.status).toBe(500);
  });
});

describe('chat.router (extended)', () => {
  describe('streak + folders', () => {
    it('GET /chat/streak/:partnerId', async () => {
      const res = await request(makeApp()).get('/chat/streak/u-2');
      expect(res.status).toBe(200);
    });

    it('GET /chat/folders', async () => {
      const res = await request(makeApp()).get('/chat/folders');
      expect(res.status).toBe(200);
    });

    it('POST /chat/folders', async () => {
      const res = await request(makeApp()).post('/chat/folders').send({ name: 'Work' });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/folders/:folderId', async () => {
      const res = await request(makeApp()).put('/chat/folders/f-1').send({ name: 'New' });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/folders/:folderId', async () => {
      const res = await request(makeApp()).delete('/chat/folders/f-1');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/folders/reorder', async () => {
      const res = await request(makeApp()).put('/chat/folders/reorder').send({ folderIds: ['f-1', 'f-2'] });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/folders/:folderId/conversations/:conversationId', async () => {
      const res = await request(makeApp()).post('/chat/folders/f-1/conversations/c-1');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/folders/conversations/:conversationId', async () => {
      const res = await request(makeApp()).delete('/chat/folders/conversations/c-1');
      expect(acceptOk(res.status)).toBe(true);
    });
  });

  describe('search', () => {
    it('GET /chat/messages/search', async () => {
      const res = await request(makeApp()).get('/chat/messages/search?q=hello');
      expect(res.status).toBe(200);
    });

    it('GET /chat/conversations/:id/messages/search', async () => {
      const res = await request(makeApp()).get('/chat/conversations/c-1/messages/search?q=hi');
      expect(res.status).toBe(200);
    });

    it('GET /chat/messages/:id/info', async () => {
      const res = await request(makeApp()).get('/chat/messages/m-1/info');
      expect(res.status).toBe(200);
    });
  });

  describe('messages — additional', () => {
    it('POST /chat/conversations/:id/messages/:mid/transcribe', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/messages/m-1/transcribe');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/messages/:mid/forward', async () => {
      const res = await request(makeApp())
        .post('/chat/conversations/c-1/messages/m-1/forward')
        .send({ targetConversationIds: ['c-2'] });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/audio', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/audio');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/image', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/image');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/album', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/album');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/document', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/document');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/video', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/video');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/gif', async () => {
      const res = await request(makeApp())
        .post('/chat/conversations/c-1/gif')
        .send({ gifUrl: 'https://media1.giphy.com/cat.gif' });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/gif rejects non-Giphy URL', async () => {
      const res = await request(makeApp())
        .post('/chat/conversations/c-1/gif')
        .send({ gifUrl: 'https://other.com/x.gif' });
      expect(res.status).toBe(400);
    });

    it('POST /chat/conversations/:id/gif rejects missing url', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/gif').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('group + members', () => {
    it('PUT /chat/conversations/:id/group', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/group').send({ name: 'New' });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/group/banner', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/group/banner').send({ banner: '' });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/group/verify', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/group/verify').send({ verified: true });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/group/call-settings', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/group/call-settings').send({});
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/conversations/:id/group', async () => {
      const res = await request(makeApp()).delete('/chat/conversations/c-1/group');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/members', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/members').send({ memberIds: ['u-2'] });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/conversations/:id/members/:userId', async () => {
      const res = await request(makeApp()).delete('/chat/conversations/c-1/members/u-2');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/members/:userId/role', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/members/u-2/role').send({});
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/members/:userId/demote', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/members/u-2/demote').send({});
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/members/:userId/ban', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/members/u-2/ban').send({});
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/conversations/:id/members/:userId/ban', async () => {
      const res = await request(makeApp()).delete('/chat/conversations/c-1/members/u-2/ban');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/invite-code', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/invite-code');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/conversations/:id/invite-code', async () => {
      const res = await request(makeApp()).delete('/chat/conversations/c-1/invite-code');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/join/:inviteCode', async () => {
      const res = await request(makeApp()).post('/chat/conversations/join/CODE');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/group/admin-settings', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/group/admin-settings').send({});
      expect(acceptOk(res.status)).toBe(true);
    });
  });

  describe('conversation actions', () => {
    it('PATCH /chat/conversations/:id/pin', async () => {
      const res = await request(makeApp()).patch('/chat/conversations/c-1/pin');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PATCH /chat/conversations/:id/mute', async () => {
      const res = await request(makeApp()).patch('/chat/conversations/c-1/mute');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PATCH /chat/conversations/:id/archive', async () => {
      const res = await request(makeApp()).patch('/chat/conversations/c-1/archive');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('PUT /chat/conversations/:id/disappearing', async () => {
      const res = await request(makeApp()).put('/chat/conversations/c-1/disappearing').send({ disappearAfterSecs: 60 });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/read', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/read');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/direct/:userId', async () => {
      const res = await request(makeApp()).post('/chat/conversations/direct/u-2');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/conversations/:id/end', async () => {
      const res = await request(makeApp()).post('/chat/conversations/c-1/end');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/conversations/:id/history', async () => {
      const res = await request(makeApp()).delete('/chat/conversations/c-1/history');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('GET /chat/conversations/:id/shared', async () => {
      const res = await request(makeApp()).get('/chat/conversations/c-1/shared');
      expect(res.status).toBe(200);
    });

    it('GET /chat/conversations/:id/messages/since', async () => {
      const res = await request(makeApp()).get('/chat/conversations/c-1/messages?sinceId=m-0');
      expect(res.status).toBe(200);
    });

    it('GET /chat/conversations/channel-inbox/:channelId/block/:subscriberUserId', async () => {
      const res = await request(makeApp()).post('/chat/conversations/channel-inbox/c-1/block/u-2');
      expect(acceptOk(res.status)).toBe(true);
    });

    it('DELETE /chat/conversations/channel-inbox/:channelId/:conversationId', async () => {
      const res = await request(makeApp()).delete('/chat/conversations/channel-inbox/c-1/c-2');
      expect(acceptOk(res.status)).toBe(true);
    });
  });

  describe('polls', () => {
    it('POST /chat/conversations/:id/polls', async () => {
      const res = await request(makeApp())
        .post('/chat/conversations/c-1/polls')
        .send({ question: 'Q', options: ['A', 'B'] });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('GET /chat/polls/:pollId', async () => {
      const res = await request(makeApp()).get('/chat/polls/p-1');
      expect(res.status).toBe(200);
    });

    it('POST /chat/polls/:pollId/vote', async () => {
      const res = await request(makeApp()).post('/chat/polls/p-1/vote').send({ optionId: 'o-1' });
      expect(acceptOk(res.status)).toBe(true);
    });

    it('POST /chat/polls/:pollId/close', async () => {
      const res = await request(makeApp()).post('/chat/polls/p-1/close');
      expect(acceptOk(res.status)).toBe(true);
    });
  });
});
