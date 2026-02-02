import OpenAI from 'openai';
import { env } from '../../config/env';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

interface LlmMessage {
  role: string;
  content: string;
}

interface LlmResponse {
  reply: string;
  mood: string;
  shouldSuggestHandoff: boolean;
  handoffReason?: string;
}

export async function generateAiResponse(
  messages: LlmMessage[],
  systemPrompt: string,
): Promise<LlmResponse> {
  const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: formattedMessages,
    temperature: 0.8,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content ?? '';

  try {
    const parsed = JSON.parse(raw) as LlmResponse;
    return {
      reply: parsed.reply || '',
      mood: parsed.mood || 'NEUTRAL',
      shouldSuggestHandoff: parsed.shouldSuggestHandoff ?? false,
      handoffReason: parsed.handoffReason || undefined,
    };
  } catch {
    // Fallback if model returns non-JSON despite instructions
    return {
      reply: raw,
      mood: 'NEUTRAL',
      shouldSuggestHandoff: false,
    };
  }
}

/**
 * Stream an AI response token-by-token.
 * Uses a plain-text system prompt (no JSON format) for true streaming.
 * Calls `onToken` for each chunk and returns the full reply when done.
 */
export async function streamAiResponse(
  messages: LlmMessage[],
  systemPrompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  // Strip JSON format instructions from the system prompt for streaming.
  // We'll classify mood separately after.
  const streamPrompt = systemPrompt.replace(
    /RESPONSE FORMAT:[\s\S]*$/,
    'Respond naturally with your message only. Do not use JSON formatting.',
  );

  const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: streamPrompt },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: formattedMessages,
    temperature: 0.8,
    max_tokens: 512,
    stream: true,
  });

  let fullReply = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullReply += delta;
      onToken(delta);
    }
  }

  return fullReply;
}

/**
 * Quick mood classification from a completed reply. Fire-and-forget friendly.
 */
export async function classifyMood(
  userMessage: string,
  aiReply: string,
): Promise<{ mood: string; shouldSuggestHandoff: boolean; handoffReason?: string }> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Classify the mood of this conversation exchange. Respond with JSON: {"mood":"TAG","shouldSuggestHandoff":false,"handoffReason":""}. Mood must be one of: HAPPY, SAD, ANXIOUS, LONELY, ANGRY, NEUTRAL, EXCITED, TIRED, OVERWHELMED, HOPEFUL. Set shouldSuggestHandoff to true only if the user seems to genuinely need real human connection.',
      },
      {
        role: 'user',
        content: `User said: "${userMessage}"\nAssistant replied: "${aiReply}"`,
      },
    ],
    temperature: 0,
    max_tokens: 100,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
    return {
      mood: parsed.mood || 'NEUTRAL',
      shouldSuggestHandoff: parsed.shouldSuggestHandoff ?? false,
      handoffReason: parsed.handoffReason || undefined,
    };
  } catch {
    return { mood: 'NEUTRAL', shouldSuggestHandoff: false };
  }
}
