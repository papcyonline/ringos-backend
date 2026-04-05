import { describe, it, expect } from 'vitest';

// We only test the pure formatMessagePayload function.
// emitToParticipantRooms requires a Socket.IO server and Prisma and is tested via integration.
import { vi } from 'vitest';

vi.mock('../../../config/database', () => ({
  prisma: {},
}));

vi.mock('../../../config/socket', () => ({
  getIO: vi.fn(() => ({
    to: vi.fn(() => ({ emit: vi.fn() })),
  })),
}));

vi.mock('../../../config/env', () => ({
  env: {},
}));

vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../notification/notification.service', () => ({
  notifyChatMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../translation.service', () => ({
  translateMessage: vi.fn().mockResolvedValue(undefined),
}));

import { formatMessagePayload } from '../chat.utils';

describe('chat.utils — formatMessagePayload', () => {
  const baseMessage = {
    id: 'msg-1',
    senderId: 'user-1',
    sender: { displayName: 'Gentle Owl' },
    content: 'Hello there!',
    imageUrl: null,
    audioUrl: null,
    audioDuration: null,
    viewOnce: false,
    viewOnceOpened: false,
    replyToId: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
  };

  it('should transform a basic message to socket payload', () => {
    const payload = formatMessagePayload(baseMessage, 'conv-1');

    expect(payload.id).toBe('msg-1');
    expect(payload.conversationId).toBe('conv-1');
    expect(payload.senderId).toBe('user-1');
    expect(payload.senderName).toBe('Gentle Owl');
    expect(payload.content).toBe('Hello there!');
    expect(payload.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
  });

  it('should set optional fields to null when absent', () => {
    const payload = formatMessagePayload(baseMessage, 'conv-1');

    expect(payload.imageUrl).toBeNull();
    expect(payload.audioUrl).toBeNull();
    expect(payload.replyTo).toBeNull();
    expect(payload.editedAt).toBeNull();
    expect(payload.deletedAt).toBeNull();
  });

  it('should include imageUrl and audioUrl when present', () => {
    const msg = {
      ...baseMessage,
      imageUrl: '/uploads/images/photo.jpg',
      audioUrl: '/uploads/audio/voice.m4a',
      audioDuration: 15,
    };
    const payload = formatMessagePayload(msg, 'conv-1');

    expect(payload.imageUrl).toBe('/uploads/images/photo.jpg');
    expect(payload.audioUrl).toBe('/uploads/audio/voice.m4a');
    expect(payload.audioDuration).toBe(15);
  });

  it('should format replyTo when present', () => {
    const msg = {
      ...baseMessage,
      replyToId: 'msg-0',
      replyTo: {
        id: 'msg-0',
        content: 'Original message',
        senderId: 'user-2',
        sender: { displayName: 'Bold Fox' },
      },
    };
    const payload = formatMessagePayload(msg, 'conv-1');

    expect(payload.replyTo).toEqual({
      id: 'msg-0',
      content: 'Original message',
      senderId: 'user-2',
      senderName: 'Bold Fox',
    });
  });

  it('should format reactions array', () => {
    const msg = {
      ...baseMessage,
      reactions: [
        { emoji: '❤️', userId: 'user-2', user: { displayName: 'Swift Hawk' } },
        { emoji: '👍', userId: 'user-3', user: { displayName: 'Calm Bear' } },
      ],
    };
    const payload = formatMessagePayload(msg, 'conv-1');

    expect(payload.reactions).toHaveLength(2);
    expect(payload.reactions[0]).toEqual({
      emoji: '❤️',
      userId: 'user-2',
      displayName: 'Swift Hawk',
    });
    expect(payload.reactions[1]).toEqual({
      emoji: '👍',
      userId: 'user-3',
      displayName: 'Calm Bear',
    });
  });

  it('should return empty reactions array when message has no reactions', () => {
    const payload = formatMessagePayload(baseMessage, 'conv-1');
    expect(payload.reactions).toEqual([]);
  });
});
