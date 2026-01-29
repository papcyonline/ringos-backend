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

export async function moderateContent(
  text: string,
): Promise<{ flagged: boolean; reason?: string; cleaned: string }> {
  let flagged = false;
  let reason: string | undefined;

  // Step 1: OpenAI Moderation API
  try {
    const modResult = await openai.moderations.create({ input: text });
    const result = modResult.results[0];
    if (result.flagged) {
      flagged = true;
      const flaggedCategories = Object.entries(result.categories)
        .filter(([, v]) => v)
        .map(([k]) => k);
      reason = `OpenAI moderation flagged: ${flaggedCategories.join(', ')}`;
    }
  } catch {
    // If OpenAI API fails, continue with other checks
  }

  // Step 2: Custom keyword filter
  if (!flagged) {
    for (const pattern of BANNED_KEYWORDS) {
      if (pattern.test(text)) {
        flagged = true;
        reason = 'Content matched banned keyword filter';
        break;
      }
    }
  }

  // Step 3: PII stripping (always applied regardless of flag status)
  let cleaned = text;
  for (const { pattern } of PII_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[removed]');
  }

  return { flagged, reason, cleaned };
}
