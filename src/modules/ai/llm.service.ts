import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai';
import { env } from '../../config/env';
import { koraToolDeclarations, executeTool, ToolResult } from './tools/kora-tools';

const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY! });
const MODEL = 'gemini-2.0-flash';

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
  const contents = messages.map((m) => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }],
  }));

  const response = await gemini.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.8,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  const raw = response.text ?? '';

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as LlmResponse;
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
 * Stream an AI response token-by-token using Gemini.
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

  const contents = messages.map((m) => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }],
  }));

  const includeTools = !!toolOpts.userId;

  const response = await gemini.models.generateContentStream({
    model: MODEL,
    contents,
    config: {
      systemInstruction: streamPrompt,
      temperature: 0.8,
      maxOutputTokens: 300,
      ...(includeTools ? {
        tools: [{ functionDeclarations: koraToolDeclarations }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      } : {}),
    },
  });

  let fullReply = '';
  const pendingCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  for await (const chunk of response) {
    // Text content
    const text = chunk.text;
    if (text) {
      fullReply += text;
      onToken(text);
    }

    // Function calls
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.functionCall) {
          pendingCalls.push({
            name: part.functionCall.name!,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  }

  // If no tool calls, we're done
  if (pendingCalls.length === 0 || !toolOpts.userId) {
    return fullReply;
  }

  // Execute tool(s) and do a second stream
  const toolMessages: Array<{ role: 'user' | 'model'; parts: any[] }> = [];

  // Add the model's function call as a model turn
  toolMessages.push({
    role: 'model',
    parts: pendingCalls.map((tc) => ({
      functionCall: { name: tc.name, args: tc.args },
    })),
  });

  // Add tool results as a user turn
  const toolResultParts: any[] = [];
  for (const tc of pendingCalls) {
    const result = await executeTool(tc.name, tc.args, toolOpts.userId!);
    toolResultParts.push({
      functionResponse: {
        name: tc.name,
        response: { content: result.llmContext },
      },
    });
    try { toolOpts.onAction?.(result.action); } catch { /* ignore SSE write errors */ }
  }
  toolMessages.push({ role: 'user', parts: toolResultParts });

  // Second call — NO tools (prevents recursion)
  const secondResponse = await gemini.models.generateContentStream({
    model: MODEL,
    contents: [...contents, ...toolMessages],
    config: {
      systemInstruction: streamPrompt,
      temperature: 0.8,
      maxOutputTokens: 300,
    },
  });

  fullReply = '';
  for await (const chunk of secondResponse) {
    const text = chunk.text;
    if (text) {
      fullReply += text;
      onToken(text);
    }
  }

  return fullReply;
}

/**
 * Stream an AI response from audio input — sends raw audio directly to Gemini
 * for voice-to-voice conversations with minimal latency.
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

  const mimeMap: Record<string, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mp3',
    opus: 'audio/opus',
    webm: 'audio/webm',
  };
  const mimeType = mimeMap[audioFormat] || 'audio/wav';

  const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [
    ...history.map((m) => ({
      role: m.role === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: m.content }],
    })),
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType,
            data: audioBase64,
          },
        },
      ],
    },
  ];

  const includeTools = !!toolOpts.userId;

  const response = await gemini.models.generateContentStream({
    model: MODEL,
    contents,
    config: {
      systemInstruction: streamPrompt,
      temperature: 0.8,
      maxOutputTokens: 300,
      ...(includeTools ? {
        tools: [{ functionDeclarations: koraToolDeclarations }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      } : {}),
    },
  });

  let fullReply = '';
  const pendingCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  for await (const chunk of response) {
    const text = chunk.text;
    if (text) {
      fullReply += text;
      onToken(text);
    }

    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.functionCall) {
          pendingCalls.push({
            name: part.functionCall.name!,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  }

  if (pendingCalls.length === 0 || !toolOpts.userId) {
    return fullReply;
  }

  // Execute tools and second stream (same pattern as text)
  const toolMessages: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  toolMessages.push({
    role: 'model',
    parts: pendingCalls.map((tc) => ({
      functionCall: { name: tc.name, args: tc.args },
    })),
  });

  const toolResultParts: any[] = [];
  for (const tc of pendingCalls) {
    const result = await executeTool(tc.name, tc.args, toolOpts.userId!);
    toolResultParts.push({
      functionResponse: {
        name: tc.name,
        response: { content: result.llmContext },
      },
    });
    try { toolOpts.onAction?.(result.action); } catch { /* ignore */ }
  }
  toolMessages.push({ role: 'user', parts: toolResultParts });

  const secondResponse = await gemini.models.generateContentStream({
    model: MODEL,
    contents: [...contents, ...toolMessages],
    config: {
      systemInstruction: streamPrompt,
      temperature: 0.8,
      maxOutputTokens: 300,
    },
  });

  fullReply = '';
  for await (const chunk of secondResponse) {
    const text = chunk.text;
    if (text) {
      fullReply += text;
      onToken(text);
    }
  }

  return fullReply;
}

/**
 * Quick mood classification from a completed reply.
 */
export async function classifyMood(
  userMessage: string,
  aiReply: string,
): Promise<{ mood: string; shouldSuggestHandoff: boolean; handoffReason?: string }> {
  const response = await gemini.models.generateContent({
    model: MODEL,
    contents: `User said: "${userMessage}"\nAssistant replied: "${aiReply}"`,
    config: {
      systemInstruction:
        'Classify the mood of this conversation exchange. Respond with JSON: {"mood":"TAG","shouldSuggestHandoff":false,"handoffReason":""}. Mood must be one of: HAPPY, SAD, ANXIOUS, LONELY, ANGRY, NEUTRAL, EXCITED, TIRED, OVERWHELMED, HOPEFUL. Set shouldSuggestHandoff to true only if the user seems to genuinely need real human connection.',
      temperature: 0,
      maxOutputTokens: 100,
      responseMimeType: 'application/json',
    },
  });

  try {
    const raw = response.text ?? '{}';
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    return {
      mood: parsed.mood || 'NEUTRAL',
      shouldSuggestHandoff: parsed.shouldSuggestHandoff ?? false,
      handoffReason: parsed.handoffReason || undefined,
    };
  } catch {
    return { mood: 'NEUTRAL', shouldSuggestHandoff: false };
  }
}
