import OpenAI from 'openai';
import { env } from '../../config/env';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const HARD_BANNED: RegExp[] = [
  /\bn[i1]gg[ae3]r?\b/i,
  /\bf[a@]gg?[o0]t\b/i,
  /\bk[i1]ke\b/i,
  /\bsp[i1]c\b/i,
  /\bch[i1]nk\b/i,
  /\btr[a@]nn[yi1]e?\b/i,
  /\br[a@]pe\b/i,
  /\bk[i1]ll\s*y[o0]urs[e3]lf\b/i,
  /\bkys\b/i,
  /\bretard(ed)?\b/i,
];

const SOFT_WARNED: RegExp[] = [
  /\bf[u\x75]ck(ing|ed|er|ers)?\b/i,
  /\bsh[i1]t(ty)?\b/i,
  /\bbullsh[i1]t\b/i,
  /\bb[i1]tch(es)?\b/i,
  /\bass(hole|holes)?\b/i,
  /\bbastard(s)?\b/i,
  /\bd[i1]ck(s)?\b/i,
  /\bwh[o0]re(s)?\b/i,
  /\bc[u\x75]nt(s)?\b/i,
  /\bslut(s)?\b/i,
];

const PII_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, label: 'phone' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: 'email' },
  { pattern: /@[A-Za-z0-9_]{1,30}\b/g, label: 'handle' },
];

/**
 * Fast, synchronous-safe local moderation: banned keywords + PII stripping.
 * Use this on the critical send path to avoid blocking on external APIs.
 */
export function moderateContentLocal(
  text: string,
): { flagged: boolean; severity?: 'hard' | 'soft'; reason?: string; cleaned: string } {
  let flagged = false;
  let severity: 'hard' | 'soft' | undefined;
  let reason: string | undefined;

  // Hard-banned keyword filter (instant reject)
  for (const pattern of HARD_BANNED) {
    if (pattern.test(text)) {
      flagged = true;
      severity = 'hard';
      reason = 'Content matched hard-banned keyword filter';
      break;
    }
  }

  // Soft-warned keyword filter (allow through, frontend already warned user)
  if (!flagged) {
    for (const pattern of SOFT_WARNED) {
      if (pattern.test(text)) {
        flagged = true;
        severity = 'soft';
        reason = 'Content matched soft-warned keyword filter';
        break;
      }
    }
  }

  // PII stripping (always applied)
  let cleaned = text;
  for (const { pattern } of PII_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[removed]');
  }

  return { flagged, severity, reason, cleaned };
}

/**
 * Full moderation: local checks + OpenAI Moderation API.
 * Call this in the background after the message is already saved & broadcast.
 */
export async function moderateContent(
  text: string,
): Promise<{ flagged: boolean; severity?: 'hard' | 'soft'; reason?: string; cleaned: string }> {
  // Run local checks first
  const local = moderateContentLocal(text);
  if (local.flagged) return local;

  // OpenAI Moderation API
  try {
    const modResult = await openai.moderations.create({ input: text });
    const result = modResult.results[0];
    if (result.flagged) {
      const flaggedCategories = Object.entries(result.categories)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return {
        flagged: true,
        severity: 'hard',
        reason: `OpenAI moderation flagged: ${flaggedCategories.join(', ')}`,
        cleaned: local.cleaned,
      };
    }
  } catch {
    // If OpenAI API fails, allow the message (local check already passed)
  }

  return local;
}
