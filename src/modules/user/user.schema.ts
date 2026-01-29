import { z } from 'zod';

const MoodTag = z.enum([
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
]);

export const updatePreferenceSchema = z.object({
  mood: MoodTag.optional(),
  language: z.string().min(1).max(10).optional(),
  timezone: z.string().min(1).max(50).optional(),
  topics: z.array(z.string().min(1).max(100)).max(20).optional(),
});

export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;

export const updateAvailabilitySchema = z.object({
  availableFor: z
    .array(z.enum(['text', 'call', 'video']))
    .min(1, 'Must be available for at least one mode'),
});

export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;
