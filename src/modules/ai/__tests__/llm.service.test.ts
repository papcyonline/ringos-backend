import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockExecuteTool } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockExecuteTool: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));
vi.mock('../../../config/env', () => ({ env: { OPENAI_API_KEY: 'k' } }));
vi.mock('../tools/kora-tools', () => ({
  koraToolDeclarations: [{ type: 'function', function: { name: 'doX' } }],
  executeTool: mockExecuteTool,
}));

import {
  generateAiResponse,
  streamAiResponse,
  streamAiResponseWithAudio,
  classifyMood,
} from '../llm.service';

beforeEach(() => {
  vi.clearAllMocks();
});

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('llm.service', () => {
  describe('generateAiResponse', () => {
    it('parses valid JSON reply', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({
          reply: 'hi', mood: 'HAPPY', shouldSuggestHandoff: false,
        })}}],
      });
      const res = await generateAiResponse([{ role: 'user', content: 'hello' }], 'sys');
      expect(res.reply).toBe('hi');
      expect(res.mood).toBe('HAPPY');
    });

    it('returns raw text on JSON parse error', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'not-json' } }],
      });
      const res = await generateAiResponse([], 'sys');
      expect(res.reply).toBe('not-json');
      expect(res.mood).toBe('NEUTRAL');
    });

    it('uses defaults when fields missing', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{}' } }],
      });
      const res = await generateAiResponse([], 'sys');
      expect(res.mood).toBe('NEUTRAL');
      expect(res.shouldSuggestHandoff).toBe(false);
    });
  });

  describe('streamAiResponse', () => {
    it('streams text tokens to callback', async () => {
      mockCreate.mockResolvedValue(asyncIter([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
      ]));
      const tokens: string[] = [];
      const reply = await streamAiResponse([{ role: 'user', content: 'hi' }], 'sys RESPONSE FORMAT: x', (t) => tokens.push(t));
      expect(reply).toBe('Hello world');
      expect(tokens).toEqual(['Hello', ' world']);
    });

    it('handles tool calls and runs second stream', async () => {
      // First stream: emits a tool call
      mockCreate.mockResolvedValueOnce(asyncIter([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'doX', arguments: '{"a":1}' } }] } }] },
      ]));
      mockExecuteTool.mockResolvedValue({ llmContext: 'tool-ok', action: { type: 'noop' } });
      // Second stream: returns final text
      mockCreate.mockResolvedValueOnce(asyncIter([
        { choices: [{ delta: { content: 'final' } }] },
      ]));

      const onAction = vi.fn();
      const tokens: string[] = [];
      const reply = await streamAiResponse(
        [{ role: 'user', content: 'do x' }],
        'sys',
        (t) => tokens.push(t),
        { userId: 'u-1', onAction },
      );
      expect(reply).toBe('final');
      expect(mockExecuteTool).toHaveBeenCalledWith('doX', { a: 1 }, 'u-1');
      expect(onAction).toHaveBeenCalledWith({ type: 'noop' });
    });

    it('returns first reply when no tool calls and no userId', async () => {
      mockCreate.mockResolvedValue(asyncIter([
        { choices: [{ delta: { content: 'plain' } }] },
      ]));
      const reply = await streamAiResponse([{ role: 'user', content: 'hi' }], 'sys', () => {});
      expect(reply).toBe('plain');
    });

    it('swallows onAction errors', async () => {
      mockCreate.mockResolvedValueOnce(asyncIter([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'doX', arguments: '{}' } }] } }] },
      ]));
      mockExecuteTool.mockResolvedValue({ llmContext: 'ok', action: { type: 'x' } });
      mockCreate.mockResolvedValueOnce(asyncIter([
        { choices: [{ delta: { content: 'final' } }] },
      ]));
      const onAction = vi.fn(() => { throw new Error('write fail'); });
      await expect(
        streamAiResponse([{ role: 'user', content: 'q' }], 'sys', () => {}, { userId: 'u-1', onAction }),
      ).resolves.toBe('final');
    });
  });

  describe('streamAiResponseWithAudio', () => {
    it('delegates to streamAiResponse', async () => {
      mockCreate.mockResolvedValue(asyncIter([
        { choices: [{ delta: { content: 'ok' } }] },
      ]));
      const reply = await streamAiResponseWithAudio([], 'sys', 'aGVsbG8=', 'mp3', () => {});
      expect(reply).toBe('ok');
    });
  });

  describe('classifyMood', () => {
    it('parses mood JSON', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({
          mood: 'SAD', shouldSuggestHandoff: true, handoffReason: 'sad',
        })}}],
      });
      const res = await classifyMood('I feel down', 'sorry');
      expect(res.mood).toBe('SAD');
      expect(res.shouldSuggestHandoff).toBe(true);
      expect(res.handoffReason).toBe('sad');
    });

    it('falls back on parse error', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'oops' } }],
      });
      const res = await classifyMood('x', 'y');
      expect(res.mood).toBe('NEUTRAL');
      expect(res.shouldSuggestHandoff).toBe(false);
    });
  });
});
