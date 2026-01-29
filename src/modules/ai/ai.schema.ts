import { z } from 'zod';

export const startSessionSchema = z.object({
  mode: z.enum(['CALM_LISTENER', 'LIGHT_AND_FUN', 'NIGHT_COMPANION', 'MOTIVATOR']),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
