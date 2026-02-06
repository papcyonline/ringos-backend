import { z } from 'zod';

export const anonymousAuthSchema = z.object({
  deviceId: z.string().uuid(),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const usernameSchema = z.object({
  username: z.string().min(3).max(8),
  bio: z.string().max(160).optional(),
  profession: z.string().max(80).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  location: z.string().max(100).optional(),
  availabilityNote: z.string().max(120).optional(),
  language: z.string().min(2).max(100).optional(),
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
  newPassword: z.string().min(6)
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit'),
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
