import { z } from 'zod';

export const createMatchRequestSchema = z.object({
  intent: z.enum(['VENT', 'CASUAL_CHAT', 'DEEP_TALK', 'ADVICE', 'JUST_LISTEN']),
  mood: z
    .enum([
      'HAPPY',
      'SAD',
      'ANXIOUS',
      'LONELY',
      'ANGRY',
      'NEUTRAL',
      'EXCITED',
      'TIRED',
      'OVERWHELMED',
      'HOPEFUL',
    ])
    .optional(),
  topics: z.array(z.string()).optional(),
  fromAiSession: z.string().uuid().optional(),
});

export type CreateMatchRequestInput = z.infer<typeof createMatchRequestSchema>;
