import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(2000),
  replyToId: z.string().uuid().optional(),
});

export const editMessageSchema = z.object({
  content: z.string().min(1).max(2000),
});

export const reactMessageSchema = z.object({
  emoji: z.enum(['thumbsup', 'heart', 'laugh', 'wow', 'sad', 'pray']),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type ReactMessageInput = z.infer<typeof reactMessageSchema>;
