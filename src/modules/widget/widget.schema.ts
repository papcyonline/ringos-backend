import { z } from 'zod';

// ─── Owner-facing (app JWT) ──────────────────────────────────────────

// A bare hostname the widget is allowed to run on, e.g. "example.com" or
// "shop.example.com". We strip any scheme/path the owner pastes by mistake.
const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((v) => v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase());

export const updateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  allowedDomains: z.array(hostname).max(20).optional(),
  // Free-form appearance/behaviour bag — validated shape-only, values are the
  // widget's concern. Kept small to avoid abuse.
  theme: z.record(z.string(), z.any()).optional(),
  offlineCapture: z.boolean().optional(),
});

// ─── Visitor-facing (public, no JWT) ─────────────────────────────────

export const startSessionSchema = z.object({
  // Present when the visitor already has a session token in localStorage and
  // is resuming; absent on first contact.
  visitorToken: z.string().trim().min(10).max(200).optional(),
  name: z.string().trim().min(1).max(60).optional(),
  email: z.string().trim().email().max(160).optional(),
});

export const visitorMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  // Client-generated UUID for idempotent retries (mirrors the app chat send).
  clientMsgId: z.string().trim().min(1).max(64).optional(),
});

export const leadSchema = z.object({
  email: z.string().trim().email().max(160),
  message: z.string().trim().min(1).max(4000),
});
