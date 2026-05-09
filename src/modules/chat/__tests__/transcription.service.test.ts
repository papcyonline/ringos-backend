import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockTranscribe,
  mockToFile,
  mockPrisma,
  mockIO,
  mockDownload,
  mockCheck,
  mockIncrement,
  mockReadFile,
} = vi.hoisted(() => ({
  mockTranscribe: vi.fn(),
  mockToFile: vi.fn(async (b: any) => ({ name: 'audio.m4a', buffer: b })),
  mockPrisma: {
    conversationParticipant: { findFirst: vi.fn() },
    message: { findUnique: vi.fn(), update: vi.fn() },
  },
  mockIO: { to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() },
  mockDownload: vi.fn(),
  mockCheck: vi.fn(),
  mockIncrement: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn(() => ({
    audio: { transcriptions: { create: mockTranscribe } },
  })),
  toFile: mockToFile,
}));
vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: { OPENAI_API_KEY: 'k' } }));
vi.mock('../../../config/socket', () => ({ getIO: () => mockIO }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../shared/gdrive.service', () => ({ downloadFromDrive: mockDownload }));
vi.mock('../../../shared/usage.service', () => ({
  checkTranscription: mockCheck,
  incrementTranscription: mockIncrement,
}));
vi.mock('fs', () => ({
  promises: { readFile: mockReadFile },
}));

let originalFetch: any;

beforeEach(() => {
  vi.clearAllMocks();
  mockCheck.mockResolvedValue({ allowed: true });
  originalFetch = (global as any).fetch;
});

afterEach(() => {
  (global as any).fetch = originalFetch;
});

import { transcribeMessage } from '../transcription.service';

describe('transcription.service', () => {
  it('throws when not a participant', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue(null);
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/participant/);
  });

  it('throws when message missing', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/Message not found/);
  });

  it('throws when message in different conversation', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: 'x', conversationId: 'other', metadata: null,
    });
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/not in conversation/);
  });

  it('throws when not a voice message', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: null, conversationId: 'c-1', metadata: null,
    });
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/voice message/);
  });

  it('returns cached transcription without calling OpenAI', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: 'x', conversationId: 'c-1',
      metadata: { transcription: 'cached' },
    });
    const res = await transcribeMessage('m-1', 'c-1', 'u-1');
    expect(res.transcription).toBe('cached');
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('throws when daily limit reached', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: 'x', conversationId: 'c-1', metadata: null,
    });
    mockCheck.mockResolvedValue({ allowed: false });
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/limit/);
  });

  it('transcribes via Whisper from Google Drive URL', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: '/media/gdrive/abc-123', conversationId: 'c-1', metadata: null,
    });
    mockDownload.mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/m4a' });
    mockTranscribe.mockResolvedValue({ text: 'hello world' });
    mockPrisma.message.update.mockResolvedValue({});

    const res = await transcribeMessage('m-1', 'c-1', 'u-1');
    expect(res.transcription).toBe('hello world');
    expect(mockIncrement).toHaveBeenCalledWith('u-1');
  });

  it('transcribes via http URL', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: 'https://res.cloudinary.com/x/voice.m4a', conversationId: 'c-1', metadata: null,
    });
    (global as any).fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => 'audio/mp4' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    mockTranscribe.mockResolvedValue({ text: 'remote' });
    mockPrisma.message.update.mockResolvedValue({});
    const res = await transcribeMessage('m-1', 'c-1', 'u-1');
    expect(res.transcription).toBe('remote');
  });

  it('throws when http fetch fails', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: 'https://x/v.m4a', conversationId: 'c-1', metadata: null,
    });
    (global as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/download/);
  });

  it('throws on empty Whisper response', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: '/media/gdrive/abc', conversationId: 'c-1', metadata: null,
    });
    mockDownload.mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/m4a' });
    mockTranscribe.mockResolvedValue({ text: '' });
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/empty/);
  });

  it('throws on unknown URL scheme', async () => {
    mockPrisma.conversationParticipant.findFirst.mockResolvedValue({ id: 'p-1' });
    mockPrisma.message.findUnique.mockResolvedValue({
      audioUrl: 'ftp://x/audio.m4a', conversationId: 'c-1', metadata: null,
    });
    await expect(transcribeMessage('m-1', 'c-1', 'u-1')).rejects.toThrow(/download/);
  });
});
