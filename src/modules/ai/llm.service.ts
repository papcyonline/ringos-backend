import OpenAI from 'openai';
import { env } from '../../config/env';
import { koraToolDeclarations, executeTool, ToolResult } from './tools/kora-tools';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const MODEL = 'gpt-4o-mini';

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
  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: chatMessages,
    temperature: 0.8,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content ?? '';

  try {
    const parsed = JSON.parse(raw) as LlmResponse;
    return {
      reply: parsed.reply || '',
      mood: parsed.mood || 'NEUTRAL',
      shouldSuggestHandoff: parsed.shouldSuggestHandoff ?? false,
      handoffReason: parsed.handoffReason || undefined,
    };
  } catch {
    return {
      reply: raw,
      mood: 'NEUTRAL',
      shouldSuggestHandoff: false,
    };
  }
}

/**
 * Stream an AI response token-by-token using OpenAI.
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
  const streamPrompt = systemPrompt.replace(
    /RESPONSE FORMAT:[\s\S]*$/,
    'Respond naturally with your message only. Do not use JSON formatting. ' +
    'IMPORTANT: Keep your responses short and conversational — 1 to 3 sentences max, like a real voice conversation. ' +
    'Do not write long paragraphs. Be warm but concise.',
  );

  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: streamPrompt },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const includeTools = !!toolOpts.userId;

  const stream = await openai.chat.completions.create({
    model: MODEL,
    messages: chatMessages,
    temperature: 0.8,
    max_tokens: 300,
    stream: true,
    ...(includeTools ? {
      tools: koraToolDeclarations as ChatCompletionTool[],
      tool_choice: 'auto',
    } : {}),
  });

  let fullReply = '';
  const toolCalls: Record<number, { name: string; args: string }> = {};

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // Text content
    if (delta?.content) {
      fullReply += delta.content;
      onToken(delta.content);
    }

    // Tool calls
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { name: '', args: '' };
        }
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    }
  }

  // If no tool calls, we're done
  const calls = Object.values(toolCalls);
  if (calls.length === 0 || !toolOpts.userId) {
    return fullReply;
  }

  // Execute tool(s) and do a second stream
  const toolMessages: ChatCompletionMessageParam[] = [
    {
      role: 'assistant',
      tool_calls: calls.map((tc, i) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    },
  ];

  for (let i = 0; i < calls.length; i++) {
    const tc = calls[i];
    const args = JSON.parse(tc.args || '{}');
    const result = await executeTool(tc.name, args, toolOpts.userId!);
    toolMessages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: result.llmContext,
    });
    try { toolOpts.onAction?.(result.action); } catch { /* ignore SSE write errors */ }
  }

  // Second call — NO tools (prevents recursion)
  const secondStream = await openai.chat.completions.create({
    model: MODEL,
    messages: [...chatMessages, ...toolMessages],
    temperature: 0.8,
    max_tokens: 300,
    stream: true,
  });

  fullReply = '';
  for await (const chunk of secondStream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) {
      fullReply += text;
      onToken(text);
    }
  }

  return fullReply;
}

/**
 * Stream an AI response from audio input — transcribes via Gemini STT then
 * uses OpenAI for the LLM response.
 */
export async function streamAiResponseWithAudio(
  history: LlmMessage[],
  systemPrompt: string,
  audioBase64: string,
  audioFormat: string,
  onToken: (token: string) => void,
  toolOpts: StreamToolOptions = {},
): Promise<string> {
  // For audio, we use the STT service to transcribe first, then pass text to OpenAI
  // The caller (ai.service.ts) already handles transcription and calls streamAiResponse
  // This function is kept for API compatibility but delegates to streamAiResponse
  // with the last user message (which should be the transcribed audio)
  return streamAiResponse(history, systemPrompt, onToken, toolOpts);
}

/**
 * Quick mood classification from a completed reply.
 */
export async function classifyMood(
  userMessage: string,
  aiReply: string,
): Promise<{ mood: string; shouldSuggestHandoff: boolean; handoffReason?: string }> {
  const response = await openai.chat.completions.create({
    model: MODEL,
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
    const raw = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    return {
      mood: parsed.mood || 'NEUTRAL',
      shouldSuggestHandoff: parsed.shouldSuggestHandoff ?? false,
      handoffReason: parsed.handoffReason || undefined,
    };
  } catch {
    return { mood: 'NEUTRAL', shouldSuggestHandoff: false };
  }
}
