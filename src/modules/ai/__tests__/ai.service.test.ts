import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockLLM } = vi.hoisted(() => {
  const mockPrisma: any = {
    user: { findUnique: vi.fn() },
    notification: { count: vi.fn() },
    aiSession: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    aiMessage: { create: vi.fn() },
  };
  const mockLLM: any = {
    generateAiResponse: vi.fn(),
    streamAiResponse: vi.fn(),
    streamAiResponseWithAudio: vi.fn(),
    classifyMood: vi.fn(),
  };
  return { mockPrisma, mockLLM };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../prompts', () => ({
  promptMap: {
    LIGHT_AND_FUN: 'You are Kora.',
    NIGHT_COMPANION: 'You are Kora at night.',
    CALM_LISTENER: 'You are Kora calm.',
    MOTIVATOR: 'You are Kora the motivator.',
    RELATIONSHIP_COACH: 'You are Kora.',
    CAREER_MENTOR: 'You are Kora.',
  },
}));
vi.mock('../llm.service', () => mockLLM);
vi.mock('../stt.service', () => ({
  transcribeAudio: vi.fn(),
}));
vi.mock('../emotion.service', () => ({
  extractMood: vi.fn((m: string) => m || 'NEUTRAL'),
}));
vi.mock('../tools/kora-tools', () => ({}));

import {
  getUserContext,
  startSession,
  sendMessage,
  endSession,
  getSession,
  getSessions,
  sendMessageStream,
  sendAudio,
  sendAudioStream,
} from '../ai.service';
import { BadRequestError, NotFoundError } from '../../../shared/errors';

const baseUser = (over: Partial<any> = {}) => ({
  displayName: 'Alice',
  bio: null,
  profession: null,
  gender: null,
  location: null,
  isVerified: false,
  preference: null,
  _count: { followsReceived: 5, followsInitiated: 7, likesReceived: 1, conversations: 3 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getUserContext ──────────────────────────────────────────────────

describe('getUserContext', () => {
  it('returns empty string when user missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    expect(await getUserContext('u-x')).toBe('');
  });

  it('builds a basic context block from name + counts', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.notification.count.mockResolvedValue(0);

    const ctx = await getUserContext('u-1');

    expect(ctx).toContain('Alice');
    expect(ctx).toContain('Followers: 5 | Following: 7');
    expect(ctx).toContain('Conversations: 3');
  });

  it('includes optional fields when present', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({
      bio: 'Engineer',
      profession: 'developer',
      gender: 'FEMALE',
      location: 'Lagos',
      isVerified: true,
      preference: { mood: 'happy', language: 'fr', topics: ['tech', 'music'] },
    }));
    mockPrisma.notification.count.mockResolvedValue(2);

    const ctx = await getUserContext('u-1');

    expect(ctx).toContain('Engineer');
    expect(ctx).toContain('developer');
    expect(ctx).toContain('female');
    expect(ctx).toContain('Lagos');
    expect(ctx).toContain('Verified: Yes');
    expect(ctx).toContain('Mood: happy');
    expect(ctx).toContain('Language: fr');
    expect(ctx).toContain('tech, music');
    expect(ctx).toContain('Unread notifications: 2');
  });

  it('omits unread line when count is 0', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.notification.count.mockResolvedValue(0);

    const ctx = await getUserContext('u-1');

    expect(ctx).not.toContain('Unread notifications');
  });
});

// ─── startSession ────────────────────────────────────────────────────

describe('startSession', () => {
  it('creates a new aiSession with the given mode', async () => {
    mockPrisma.aiSession.create.mockResolvedValue({ id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', messages: [] });

    const res = await startSession('u-1', 'LIGHT_AND_FUN' as any);

    expect(res.id).toBe('s-1');
    expect(mockPrisma.aiSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { userId: 'u-1', mode: 'LIGHT_AND_FUN' },
    }));
  });
});

// ─── sendMessage ─────────────────────────────────────────────────────

describe('sendMessage', () => {
  it('throws when session missing', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue(null);
    await expect(sendMessage('s-x', 'u-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when session belongs to a different user', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'someone-else', status: 'ACTIVE', mode: 'LIGHT_AND_FUN', messages: [],
    });
    await expect(sendMessage('s-1', 'u-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects sending to ENDED session', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', status: 'ENDED', mode: 'LIGHT_AND_FUN', messages: [],
    });
    await expect(sendMessage('s-1', 'u-1', 'hi')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('persists user message + AI response and returns formatted reply', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', status: 'ACTIVE', mode: 'LIGHT_AND_FUN',
      messages: [{ role: 'USER', content: 'hello' }],
    });
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.notification.count.mockResolvedValue(0);
    mockLLM.generateAiResponse.mockResolvedValue({
      reply: 'Hi back!',
      mood: 'HAPPY',
      shouldSuggestHandoff: false,
      handoffReason: null,
    });

    const res = await sendMessage('s-1', 'u-1', 'how are you');

    expect(res.content).toBe('Hi back!');
    expect(res.mood).toBe('HAPPY');
    expect(res.should_handoff).toBe(false);
    // First create = user msg, second = AI msg
    expect(mockPrisma.aiMessage.create).toHaveBeenCalledTimes(2);
  });
});

// ─── endSession ──────────────────────────────────────────────────────

describe('endSession', () => {
  it('throws when session missing', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue(null);
    await expect(endSession('s-x', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when session belongs to different user', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ id: 's-1', userId: 'other', status: 'ACTIVE' });
    await expect(endSession('s-1', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects already-ended session', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ id: 's-1', userId: 'u-1', status: 'ENDED' });
    await expect(endSession('s-1', 'u-1')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('marks session ENDED', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ id: 's-1', userId: 'u-1', status: 'ACTIVE' });

    await endSession('s-1', 'u-1');

    expect(mockPrisma.aiSession.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { status: 'ENDED' },
    });
  });
});

// ─── getSession ──────────────────────────────────────────────────────

describe('getSession', () => {
  it('throws when missing', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue(null);
    await expect(getSession('s-x', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when caller is not the owner', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ id: 's-1', userId: 'other', messages: [] });
    await expect(getSession('s-1', 'u-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns session with messages when owner', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ id: 's-1', userId: 'u-1', messages: [] });

    const res = await getSession('s-1', 'u-1');

    expect(res.id).toBe('s-1');
  });
});

// ─── getSessions ─────────────────────────────────────────────────────

describe('getSessions', () => {
  it('returns user sessions ordered desc by createdAt', async () => {
    mockPrisma.aiSession.findMany.mockResolvedValue([
      { id: 's-1' }, { id: 's-2' },
    ]);

    const res = await getSessions('u-1');

    expect(res).toHaveLength(2);
    expect(mockPrisma.aiSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u-1' },
      orderBy: { createdAt: 'desc' },
    }));
  });
});

describe('sendMessageStream', () => {
  beforeEach(() => {
    mockPrisma.aiMessage.create.mockResolvedValue({ id: 'msg' });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.notification.count.mockResolvedValue(0);
  });

  it('throws when session not found', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue(null);
    await expect(
      sendMessageStream('s-1', 'u-1', 'hi', () => {}, () => {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when session belongs to different user', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'other', mode: 'LIGHT_AND_FUN', status: 'ACTIVE', messages: [],
    });
    await expect(
      sendMessageStream('s-1', 'u-1', 'hi', () => {}, () => {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects ENDED session', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', status: 'ENDED', messages: [],
    });
    await expect(
      sendMessageStream('s-1', 'u-1', 'hi', () => {}, () => {}),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('streams reply and persists messages on success', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', status: 'ACTIVE',
      messages: [{ role: 'USER', content: 'hi' }, { role: 'ASSISTANT', content: 'hello' }],
    });
    mockLLM.streamAiResponse.mockResolvedValue('stream reply');
    mockLLM.classifyMood.mockResolvedValue({ mood: 'HAPPY', shouldSuggestHandoff: false });

    const tokens: string[] = [];
    const onDone = vi.fn();
    await sendMessageStream('s-1', 'u-1', 'hi', (t) => tokens.push(t), onDone);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockLLM.streamAiResponse).toHaveBeenCalled();
    expect(mockPrisma.aiMessage.create).toHaveBeenCalled();
  });

  it('falls back when classifyMood errors', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', status: 'ACTIVE', messages: [],
    });
    mockLLM.streamAiResponse.mockResolvedValue('reply');
    mockLLM.classifyMood.mockRejectedValue(new Error('llm-down'));
    const onDone = vi.fn();
    await sendMessageStream('s-1', 'u-1', 'hi', () => {}, onDone);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ mood: 'NEUTRAL' }));
  });
});

describe('sendAudio', () => {
  it('throws when transcription is empty', async () => {
    const stt = await import('../stt.service');
    (stt.transcribeAudio as any).mockResolvedValue('   ');
    await expect(sendAudio('s-1', 'u-1', Buffer.from('x'), 'audio/mp4'))
      .rejects.toBeInstanceOf(BadRequestError);
  });

  it('forwards transcribed text to sendMessage', async () => {
    const stt = await import('../stt.service');
    (stt.transcribeAudio as any).mockResolvedValue('hello world');

    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', status: 'ACTIVE', messages: [],
    });
    mockLLM.generateAiResponse.mockResolvedValue({
      reply: 'hi', mood: 'NEUTRAL', shouldSuggestHandoff: false,
    });
    mockPrisma.aiMessage.create.mockResolvedValue({});

    const res = await sendAudio('s-1', 'u-1', Buffer.from('x'), 'audio/mp4');
    expect(res.transcription).toBe('hello world');
  });
});

describe('sendAudioStream', () => {
  beforeEach(() => {
    mockPrisma.aiMessage.create.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.notification.count.mockResolvedValue(0);
  });

  it('throws when session not found', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue(null);
    await expect(
      sendAudioStream('s-1', 'u-1', Buffer.from('x'), 'audio/mp4', () => {}, () => {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('streams audio response on success', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', status: 'ACTIVE', messages: [],
    });
    mockLLM.streamAiResponseWithAudio.mockResolvedValue('audio reply');
    mockLLM.classifyMood.mockResolvedValue({ mood: 'NEUTRAL', shouldSuggestHandoff: false });

    const onDone = vi.fn();
    await sendAudioStream('s-1', 'u-1', Buffer.from('x'), 'audio/wav', () => {}, onDone);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockLLM.streamAiResponseWithAudio).toHaveBeenCalled();
  });

  it('handles classifyMood failure', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({
      id: 's-1', userId: 'u-1', mode: 'LIGHT_AND_FUN', status: 'ACTIVE', messages: [],
    });
    mockLLM.streamAiResponseWithAudio.mockResolvedValue('reply');
    mockLLM.classifyMood.mockRejectedValue(new Error('llm-down'));
    const onDone = vi.fn();
    await sendAudioStream('s-1', 'u-1', Buffer.from('x'), 'audio/mp3', () => {}, onDone);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ mood: 'NEUTRAL' }));
  });
});
