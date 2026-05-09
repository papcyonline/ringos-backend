import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(() => ({ models: { generateContent: mockGenerateContent } })),
}));
vi.mock('../../../config/env', () => ({ env: { GEMINI_API_KEY: 'k' } }));

import { transcribeAudio } from '../stt.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stt.service', () => {
  it('returns trimmed transcript text', async () => {
    mockGenerateContent.mockResolvedValue({ text: '  hello world  ' });
    const res = await transcribeAudio(Buffer.from('audio'));
    expect(res).toBe('hello world');
  });

  it('returns empty string when text missing', async () => {
    mockGenerateContent.mockResolvedValue({});
    const res = await transcribeAudio(Buffer.from('audio'));
    expect(res).toBe('');
  });

  it('respects custom mimeType', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'x' });
    await transcribeAudio(Buffer.from('audio'), 'audio/mp3');
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents[0].parts[0].inlineData.mimeType).toBe('audio/mp3');
  });
});
