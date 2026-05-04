import { z } from 'zod';

export const anonymousAuthSchema = z.object({
  deviceId: z.string().uuid(),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const usernameSchema = z.object({
  username: z.string().min(3).max(12),
  // Bio min lowered from 10 → 5 to match the frontend nudge for shorter
  // bios. Single-word bios like "hello" now pass.
  bio: z.string().min(5, 'Bio must be at least 5 characters').max(200),
  profession: z.string().min(2, 'Profession is required').max(80),
  // Gender is optional — Apple Guideline 5.1.1 rejected the previous
  // submission for requiring it. Frontend doesn't collect it; this
  // exists only so legacy / API clients can still pass it.
  gender: z
    .enum(['male', 'female', 'MALE', 'FEMALE'])
    .transform((v) => v.toUpperCase() as 'MALE' | 'FEMALE')
    .optional(),
  // Location optional — same Apple rejection forced this. Frontend
  // shows the field without an "(optional)" tag as a soft nudge but
  // doesn't gate submission on it.
  location: z.string().min(2).max(100).optional(),
  // ISO 8601 date string. Required on profile completion (COPPA /
  // GDPR-K compliance + App Store age-gating). The 13+ age check
  // happens in the service layer where we have the parsed Date.
  dateOfBirth: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')),
  availabilityNote: z.string().max(120).optional(),
  language: z
    .string()
    .min(2)
    .max(10)
    .refine(
      (v) => v.split(',').map((s) => s.trim()).filter(Boolean).length <= 2,
      'At most 2 languages allowed',
    )
    .optional(),
});

export const phoneAuthSchema = z.object({
  phone: z.string().min(10),
});

export const verifyOtpSchema = z.object({
  phone: z.string().min(10),
  code: z.string().length(6),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z.string().min(8, 'Password must be at least 8 characters')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit'),
});

export const emailOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export const resendOtpSchema = z.object({
  email: z.string().email(),
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(1),
});

export const appleAuthSchema = z.object({
  idToken: z.string().min(1),
  fullName: z.object({
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  }).optional(),
});
