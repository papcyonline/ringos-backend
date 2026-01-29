import { z } from 'zod';

export const anonymousAuthSchema = z.object({
  deviceId: z.string().uuid(),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const usernameSchema = z.object({
  username: z.string().min(3).max(30),
  bio: z.string().max(160).optional(),
  profession: z.string().max(80).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  location: z.string().max(100).optional(),
  availabilityNote: z.string().max(120).optional(),
  language: z.string().min(2).max(10).optional(),
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
