import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().max(2000).optional().default(''),
  replyToId: z.string().uuid().optional(),
  imageUrl: z.string().url().optional(),
  audioUrl: z.string().url().optional(),
  audioDuration: z.number().int().min(0).optional(),
  viewOnce: z.boolean().optional(),
}).refine(
  (data) => (data.content && data.content.length > 0) || data.imageUrl || data.audioUrl,
  { message: 'Message must have content, image, or audio' },
);

export const editMessageSchema = z.object({
  content: z.string().min(1).max(2000),
});

export const reactMessageSchema = z.object({
  emoji: z.string().min(1).max(32),
});

export const forwardMessageSchema = z.object({
  targetConversationId: z.string().uuid(),
});

export const searchMessagesSchema = z.object({
  q: z.string().min(1).max(200),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type ReactMessageInput = z.infer<typeof reactMessageSchema>;
