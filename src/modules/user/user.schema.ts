import { z } from 'zod';
import { containsExplicitText } from '../../shared/text-moderation.service';

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
  availabilityNote: z.string().max(200).refine((v) => !containsExplicitText(v), 'This content is not allowed').optional(),
  status: z.enum(['available', 'busy']).optional(),
  availableUntil: z.string().datetime().optional().nullable(),
});

export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;

export const updatePrivacySchema = z.object({
  isProfilePublic: z.boolean().optional(),
  hideOnlineStatus: z.boolean().optional(),
  hideReadReceipts: z.boolean().optional(),
});

export type UpdatePrivacyInput = z.infer<typeof updatePrivacySchema>;

// Profile link pill shown on profiles. Value semantics depend on type
// (URL for website; address for email; number for phone; handle or URL for
// socials). The service sanitizes/normalizes values before persisting.
export const PROFILE_LINK_TYPES = [
  'website', 'email', 'phone', 'instagram', 'x', 'facebook', 'linkedin', 'tiktok',
] as const;

export const profileLinkSchema = z.object({
  type: z.enum(PROFILE_LINK_TYPES),
  label: z.string().trim().min(1).max(24)
    .refine((v) => !containsExplicitText(v), 'This content is not allowed'),
  value: z.string().trim().min(1).max(300),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(50).refine((v) => !containsExplicitText(v), 'This content is not allowed').optional(),
  bio: z.string().max(500).refine((v) => !containsExplicitText(v), 'This content is not allowed').optional().nullable(),
  profession: z.string().max(100).optional().nullable(),
  gender: z.enum(['male', 'female', 'MALE', 'FEMALE']).transform(v => v?.toUpperCase() as 'MALE' | 'FEMALE').optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  profileLinks: z.array(profileLinkSchema).max(5).optional().nullable(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
