import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().max(2000).optional().default(''),
  replyToId: z.string().uuid().optional(),
  imageUrl: z.string().optional(),
  audioUrl: z.string().optional(),
  audioDuration: z.number().int().min(0).optional(),
  viewOnce: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
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
  targetConversationId: z.string().uuid().optional(),
  targetConversationIds: z.array(z.string().uuid()).min(1).max(5).optional(),
}).refine(
  (d) => !!d.targetConversationId || !!d.targetConversationIds,
  { message: 'targetConversationId or targetConversationIds is required' },
);

export const searchMessagesSchema = z.object({
  q: z.string().min(1).max(200),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type ReactMessageInput = z.infer<typeof reactMessageSchema>;
