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
  // Optional: pinpoint the specific content being reported (Apple Guideline 1.2).
  // reportedId is still required and identifies the content's author.
  contentType: z.enum(['STORY', 'REEL', 'POST', 'MESSAGE', 'COMMENT']).optional(),
  contentId: z.string().max(100).optional(),
});

export const blockSchema = z.object({
  blockedId: z.string().uuid(),
});
