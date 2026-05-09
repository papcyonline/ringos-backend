import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockPrisma, mockIO } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockPrisma: {
    conversationParticipant: { findMany: vi.fn() },
    message: { findUnique: vi.fn(), update: vi.fn() },
  },
  mockIO: { to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() },
}));

vi.mock('openai', () => ({
  default: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));
vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: { OPENAI_API_KEY: 'k' } }));
vi.mock('../../../config/socket', () => ({ getIO: () => mockIO }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { translateMessage } from '../translation.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.message.findUnique.mockResolvedValue({ metadata: {} });
  mockPrisma.message.update.mockResolvedValue({});
});

describe('translation.service', () => {
  it('skips empty content', async () => {
    await translateMessage('m-1', 'c-1', '   ');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips emoji-only messages', async () => {
    await translateMessage('m-1', 'c-1', '😂😂😂');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips URL-only messages', async () => {
    await translateMessage('m-1', 'c-1', 'https://example.com');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips when most words are short', async () => {
    await translateMessage('m-1', 'c-1', 'lol omg ngl');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips when no targets', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([]);
    await translateMessage('m-1', 'c-1', 'Hello, this morning seems wonderful indeed');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('translates when participants speak different language', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { user: { preference: { language: 'en' } } },
      { user: { preference: { language: 'fr,es' } } },
    ]);
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        detectedLanguage: 'en',
        translations: { fr: 'bonjour', es: 'hola' },
      })}}],
    });
    await translateMessage('m-1', 'c-1', 'Hello, this morning seems wonderful indeed');
    expect(mockPrisma.message.update).toHaveBeenCalled();
    expect(mockIO.to).toHaveBeenCalledWith('conversation:c-1');
  });

  it('removes source language from translations', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { user: { preference: { language: 'en' } } },
    ]);
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        detectedLanguage: 'en',
        translations: { en: 'echo' },
      })}}],
    });
    await translateMessage('m-1', 'c-1', 'Hello world today');
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it('skips when LLM returns no parsed result', async () => {
    mockPrisma.conversationParticipant.findMany.mockResolvedValue([
      { user: { preference: { language: 'fr' } } },
    ]);
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '' } }] });
    await translateMessage('m-1', 'c-1', 'Hello world');
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it('catches errors silently', async () => {
    mockPrisma.conversationParticipant.findMany.mockRejectedValue(new Error('db'));
    await expect(translateMessage('m-1', 'c-1', 'Hello world')).resolves.toBeUndefined();
  });
});
