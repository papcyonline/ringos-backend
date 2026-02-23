import OpenAI from 'openai';
import { env } from '../../config/env';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const BANNED_KEYWORDS: RegExp[] = [
  /\bn[i1]gg[ae3]r?\b/i,
  /\bf[a@]gg?[o0]t\b/i,
  /\bk[i1]ke\b/i,
  /\bsp[i1]c\b/i,
  /\bch[i1]nk\b/i,
  /\btr[a@]nn[yi1]e?\b/i,
  /\bwh[o0]re\b/i,
  /\bc[u\x75]nt\b/i,
  /\br[a@]pe\b/i,
  /\bk[i1]ll\s*y[o0]urs[e3]lf\b/i,
  /\bkys\b/i,
  /\bslut\b/i,
  /\bretard(ed)?\b/i,
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
): { flagged: boolean; reason?: string; cleaned: string } {
  let flagged = false;
  let reason: string | undefined;

  // Keyword filter (instant)
  for (const pattern of BANNED_KEYWORDS) {
    if (pattern.test(text)) {
      flagged = true;
      reason = 'Content matched banned keyword filter';
      break;
    }
  }

  // PII stripping (always applied)
  let cleaned = text;
  for (const { pattern } of PII_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[removed]');
  }

  return { flagged, reason, cleaned };
}

/**
 * Full moderation: local checks + OpenAI Moderation API.
 * Call this in the background after the message is already saved & broadcast.
 */
export async function moderateContent(
  text: string,
): Promise<{ flagged: boolean; reason?: string; cleaned: string }> {
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
        reason: `OpenAI moderation flagged: ${flaggedCategories.join(', ')}`,
        cleaned: local.cleaned,
      };
    }
  } catch {
    // If OpenAI API fails, allow the message (local check already passed)
  }

  return local;
}
