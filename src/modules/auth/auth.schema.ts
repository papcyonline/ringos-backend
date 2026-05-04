import { z } from 'zod';

/**
 * Server-side mirror of the frontend's _isReadableText gate (see
 * Frontend/lib/features/auth/presentation/screens/username_screen.dart).
 * Both ends apply the same rules so a non-frontend client can't bypass
 * the readability check by POSTing keyboard-mash like "qweqrqrw".
 *
 * Rejects:
 *  - 4+ identical chars in a row (aaaaaa, qqqqq)
 *  - 4+ consecutive consonants (qweqrqrw → qrqr; qwert → qwrt)
 *  - any word (2+ letters) without a vowel (qrqr, bcd)
 *  - single letter dominating > 40% of all letters once total ≥ 6
 *    (aerareee → e is 50%). Skipped for shorter strings so legitimate
 *    short words like "anna" still pass.
 */
function isReadableText(value: string): boolean {
  const lower = value.toLowerCase();
  if (/(.)\1{3}/.test(lower)) return false;
  if (/[bcdfghjklmnpqrstvwxz]{4}/.test(lower)) return false;
  for (const w of lower.split(/\s+/)) {
    const letters = w.replace(/[^a-z]/g, '');
    if (letters.length >= 2 && !/[aeiouy]/.test(letters)) {
      return false;
    }
  }
  const allLetters = lower.replace(/[^a-z]/g, '');
  if (allLetters.length >= 6) {
    const counts: Record<string, number> = {};
    for (const c of allLetters) {
      counts[c] = (counts[c] ?? 0) + 1;
    }
    const maxCount = Math.max(...Object.values(counts));
    if (maxCount / allLetters.length > 0.4) return false;
  }
  return true;
}

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
  // bios. Single-word bios like "hello" now pass. Readability gate is
  // shared with the frontend (see isReadableText above).
  bio: z
    .string()
    .min(5, 'Bio must be at least 5 characters')
    .max(200)
    .refine(isReadableText, 'Bio looks like keyboard-mash — please write something readable'),
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
  // Profession and dateOfBirth removed entirely from signup per Apple
  // Guideline 5.1.1(v) (build 136 / 138 rejections). DB columns remain
  // for existing users and for the (separate) profile-edit endpoint to
  // populate, but the username / signup endpoint no longer accepts
  // either field.
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
