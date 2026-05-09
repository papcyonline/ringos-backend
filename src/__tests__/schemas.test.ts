import { describe, it, expect } from 'vitest';

import { sendMessageSchema, editMessageSchema, reactMessageSchema, forwardMessageSchema, searchMessagesSchema } from '../modules/chat/chat.schema';
import { startSessionSchema, sendMessageSchema as aiSendMessageSchema } from '../modules/ai/ai.schema';
import { createMatchRequestSchema } from '../modules/matching/matching.schema';

describe('chat.schema', () => {
  it('sendMessageSchema requires content/image/audio', () => {
    expect(() => sendMessageSchema.parse({})).toThrow();
    expect(() => sendMessageSchema.parse({ content: 'hi' })).not.toThrow();
    expect(() => sendMessageSchema.parse({ imageUrl: 'x' })).not.toThrow();
  });

  it('editMessageSchema requires non-empty content', () => {
    expect(() => editMessageSchema.parse({ content: '' })).toThrow();
    expect(() => editMessageSchema.parse({ content: 'edit' })).not.toThrow();
  });

  it('reactMessageSchema requires emoji', () => {
    expect(() => reactMessageSchema.parse({ emoji: '❤️' })).not.toThrow();
    expect(() => reactMessageSchema.parse({ emoji: '' })).toThrow();
  });

  it('forwardMessageSchema requires single OR multi target', () => {
    expect(() => forwardMessageSchema.parse({})).toThrow();
    expect(() => forwardMessageSchema.parse({
      targetConversationId: '123e4567-e89b-12d3-a456-426614174000',
    })).not.toThrow();
  });

  it('forwardMessageSchema enforces array max', () => {
    expect(() => forwardMessageSchema.parse({
      targetConversationIds: Array.from({ length: 6 }, () => '123e4567-e89b-12d3-a456-426614174000'),
    })).toThrow();
  });

  it('searchMessagesSchema requires q', () => {
    expect(() => searchMessagesSchema.parse({ q: 'hi' })).not.toThrow();
    expect(() => searchMessagesSchema.parse({ q: '' })).toThrow();
  });
});

describe('ai.schema', () => {
  it('startSessionSchema accepts valid modes', () => {
    expect(() => startSessionSchema.parse({ mode: 'LIGHT_AND_FUN' })).not.toThrow();
    expect(() => startSessionSchema.parse({ mode: 'INVALID' as any })).toThrow();
  });

  it('aiSendMessageSchema enforces length', () => {
    expect(() => aiSendMessageSchema.parse({ content: 'hi' })).not.toThrow();
    expect(() => aiSendMessageSchema.parse({ content: '' })).toThrow();
    expect(() => aiSendMessageSchema.parse({ content: 'x'.repeat(5001) })).toThrow();
  });
});

describe('matching.schema', () => {
  it('createMatchRequestSchema accepts intents', () => {
    expect(() => createMatchRequestSchema.parse({ intent: 'CHAT' as any })).toThrow();
    expect(() => createMatchRequestSchema.parse({ intent: 'CASUAL_CHAT' })).not.toThrow();
  });

  it('createMatchRequestSchema accepts optional fields', () => {
    expect(() => createMatchRequestSchema.parse({
      intent: 'DEEP_TALK',
      mood: 'HAPPY',
      topics: ['music'],
      fromAiSession: '123e4567-e89b-12d3-a456-426614174000',
    })).not.toThrow();
  });
});
