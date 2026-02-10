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
  availabilityNote: z.string().max(200).optional(),
  status: z.enum(['available', 'busy']).optional(),
  availableUntil: z.string().datetime().optional().nullable(),
});

export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;

export const updatePrivacySchema = z.object({
  isProfilePublic: z.boolean().optional(),
  hideOnlineStatus: z.boolean().optional(),
});

export type UpdatePrivacyInput = z.infer<typeof updatePrivacySchema>;

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  bio: z.string().max(80).optional().nullable(),
  profession: z.string().max(100).optional().nullable(),
  gender: z.enum(['male', 'female']).optional().nullable(),
  location: z.string().max(100).optional().nullable(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
