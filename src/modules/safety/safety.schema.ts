import { z } from 'zod';

export const reportSchema = z.object({
  reportedId: z.string().uuid(),
  reason: z.enum([
    'HARASSMENT',
    'SPAM',
    'INAPPROPRIATE_CONTENT',
    'SELF_HARM',
    'THREATS',
    'OTHER',
  ]),
  details: z.string().max(500).optional(),
});

export const blockSchema = z.object({
  blockedId: z.string().uuid(),
});
