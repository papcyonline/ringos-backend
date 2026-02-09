import OpenAI from 'openai';
import { env } from '../../config/env';
import { koraToolSchemas, executeTool, ToolResult } from './tools/kora-tools';

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

interface StreamToolOptions {
  userId?: string;
  onAction?: (action: ToolResult['action']) => void;
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
 *
 * When `toolOpts.userId` is provided, tools are included in the first call.
 * If the model invokes a tool, it is executed and a second (tool-free) stream
 * delivers the final conversational reply.
 */
export async function streamAiResponse(
  messages: LlmMessage[],
  systemPrompt: string,
  onToken: (token: string) => void,
  toolOpts: StreamToolOptions = {},
): Promise<string> {
  // Strip JSON format instructions from the system prompt for streaming.
  // We'll classify mood separately after.
  const streamPrompt = systemPrompt.replace(
    /RESPONSE FORMAT:[\s\S]*$/,
    'Respond naturally with your message only. Do not use JSON formatting. ' +
    'IMPORTANT: Keep your responses short and conversational — 1 to 3 sentences max, like a real voice conversation. ' +
    'Do not write long paragraphs. Be warm but concise.',
  );

  const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: streamPrompt },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const includeTools = !!toolOpts.userId;

  // ── First streaming call (may include tools) ──
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: formattedMessages,
    temperature: 0.8,
    max_tokens: 300,
    stream: true,
    ...(includeTools ? { tools: koraToolSchemas, tool_choice: 'auto' as const } : {}),
  });

  let fullReply = '';
  // Accumulate tool_calls deltas
  const toolCallMap: Record<number, { id: string; name: string; args: string }> = {};

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;

    // Content tokens
    const delta = choice.delta?.content;
    if (delta) {
      fullReply += delta;
      onToken(delta);
    }

    // Tool call deltas
    const toolCalls = (choice.delta as any)?.tool_calls as
      | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
      | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (!toolCallMap[tc.index]) {
          toolCallMap[tc.index] = { id: tc.id ?? '', name: '', args: '' };
        }
        if (tc.id) toolCallMap[tc.index].id = tc.id;
        if (tc.function?.name) toolCallMap[tc.index].name += tc.function.name;
        if (tc.function?.arguments) toolCallMap[tc.index].args += tc.function.arguments;
      }
    }
  }

  // ── If no tool calls, we're done ──
  const pendingCalls = Object.values(toolCallMap);
  if (pendingCalls.length === 0 || !toolOpts.userId) {
    return fullReply;
  }

  // ── Execute tool(s) and do a second stream ──
  const assistantToolCallMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'assistant',
    content: null,
    tool_calls: pendingCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    })),
  };

  const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const tc of pendingCalls) {
    let parsedArgs: Record<string, unknown> = {};
    try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { /* empty args */ }

    const result = await executeTool(tc.name, parsedArgs, toolOpts.userId!);

    toolResultMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: result.llmContext,
    } as any);

    // Emit action to frontend (wrapped in try-catch: client may have disconnected)
    try { toolOpts.onAction?.(result.action); } catch { /* ignore SSE write errors */ }
  }

  // Second call — NO tools (prevents recursion)
  const secondMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...formattedMessages,
    assistantToolCallMsg,
    ...toolResultMessages,
  ];

  const secondStream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: secondMessages,
    temperature: 0.8,
    max_tokens: 300,
    stream: true,
  });

  fullReply = '';
  for await (const chunk of secondStream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullReply += delta;
      onToken(delta);
    }
  }

  return fullReply;
}

/**
 * Stream an AI response from audio input — sends raw audio directly to GPT-4o
 * (bypassing Whisper STT) for voice-to-voice conversations with minimal latency.
 * The model hears the user's voice and generates a text reply, streamed via `onToken`.
 *
 * Supports tool calling when `toolOpts.userId` is provided (same pattern as text).
 */
export async function streamAiResponseWithAudio(
  history: LlmMessage[],
  systemPrompt: string,
  audioBase64: string,
  audioFormat: string,
  onToken: (token: string) => void,
  toolOpts: StreamToolOptions = {},
): Promise<string> {
  const streamPrompt = systemPrompt.replace(
    /RESPONSE FORMAT:[\s\S]*$/,
    'Respond naturally with your message only. Do not use JSON formatting. ' +
    'IMPORTANT: Keep your responses short and conversational — 1 to 3 sentences max, like a real voice conversation. ' +
    'Do not write long paragraphs. Be warm but concise.',
  );

  const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: streamPrompt },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    {
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: {
            data: audioBase64,
            format: audioFormat,
          },
        } as any,
      ],
    },
  ];

  const includeTools = !!toolOpts.userId;

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-audio-preview',
    modalities: ['text'],
    messages: formattedMessages,
    temperature: 0.8,
    max_tokens: 300,
    stream: true,
    ...(includeTools ? { tools: koraToolSchemas, tool_choice: 'auto' as const } : {}),
  } as Parameters<typeof openai.chat.completions.create>[0]);

  let fullReply = '';
  const toolCallMap: Record<number, { id: string; name: string; args: string }> = {};

  for await (const chunk of stream as any) {
    const choice = (chunk as any).choices[0];
    if (!choice) continue;

    const delta = choice.delta?.content;
    if (delta) {
      fullReply += delta;
      onToken(delta);
    }

    const toolCalls = choice.delta?.tool_calls as
      | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
      | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (!toolCallMap[tc.index]) {
          toolCallMap[tc.index] = { id: tc.id ?? '', name: '', args: '' };
        }
        if (tc.id) toolCallMap[tc.index].id = tc.id;
        if (tc.function?.name) toolCallMap[tc.index].name += tc.function.name;
        if (tc.function?.arguments) toolCallMap[tc.index].args += tc.function.arguments;
      }
    }
  }

  const pendingCalls = Object.values(toolCallMap);
  if (pendingCalls.length === 0 || !toolOpts.userId) {
    return fullReply;
  }

  // ── Execute tool(s) and do a second stream ──
  const assistantToolCallMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: 'assistant',
    content: null,
    tool_calls: pendingCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    })),
  };

  const toolResultMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const tc of pendingCalls) {
    let parsedArgs: Record<string, unknown> = {};
    try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { /* empty args */ }

    const result = await executeTool(tc.name, parsedArgs, toolOpts.userId!);

    toolResultMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: result.llmContext,
    } as any);

    try { toolOpts.onAction?.(result.action); } catch { /* ignore SSE write errors */ }
  }

  // Second call uses gpt-4o-mini (text only, no audio) — no tools
  const secondMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...formattedMessages,
    assistantToolCallMsg,
    ...toolResultMessages,
  ];

  const secondStream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: secondMessages,
    temperature: 0.8,
    max_tokens: 300,
    stream: true,
  });

  fullReply = '';
  for await (const chunk of secondStream) {
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
