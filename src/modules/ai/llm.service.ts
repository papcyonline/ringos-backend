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
    model: 'gpt-4',
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
    // Fallback if GPT-4 returns non-JSON despite instructions
    return {
      reply: raw,
      mood: 'NEUTRAL',
      shouldSuggestHandoff: false,
    };
  }
}
