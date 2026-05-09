import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
}));
vi.mock('../../../config/env', () => ({ env: { GEMINI_API_KEY: 'k' } }));

import { synthesizeSpeech } from '../tts.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tts.service', () => {
  it('returns audio buffer when response has inlineData', async () => {
    const base64 = Buffer.from('audio').toString('base64');
    mockGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { data: base64 } }] } }],
    });
    const buf = await synthesizeSpeech('hello');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('audio');
  });

  it('throws when no audio data in response', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{}] } }],
    });
    await expect(synthesizeSpeech('hello')).rejects.toThrow(/No audio/);
  });

  it('throws when no candidates', async () => {
    mockGenerateContent.mockResolvedValue({});
    await expect(synthesizeSpeech('hello')).rejects.toThrow(/No audio/);
  });
});
