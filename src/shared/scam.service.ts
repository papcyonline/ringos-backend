/**
 * Lightweight scam-signal detection for chat text.
 *
 * This is intentionally NOT a moderation gate — it never blocks a message.
 * It powers a "warn + flag" flow: a recipient sees a safety banner and an
 * internal ScamFlag row is written for later human review. Because the
 * output only warns (never bans), we bias toward catching the two signals
 * that define romance / investment ("pig-butchering") scams — moving the
 * conversation off-platform, and money asks — while deliberately avoiding
 * high-false-positive tokens (Instagram / Snapchat handles are normal to
 * swap between real users, so they are NOT flagged).
 */

export type ScamCategory = 'OFF_PLATFORM' | 'MONEY' | 'CONTACT';

// Normalise leet-speak / spacing tricks used to dodge keyword matching
// (e.g. "w h a t s a p p", "t3l3gram"). Mirrors the approach in
// moderation.service.ts's text filter.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1|!]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    // collapse "w h a t s" style single-char spacing into "whats"
    .replace(/\b(\w)(\s)(?=\w\s\w)/g, '$1')
    .replace(/\s+/g, ' ');
}

// Moving the chat to another app — the hallmark of a scammer escaping
// on-platform moderation. Instagram/Snapchat/TikTok are omitted on purpose.
const OFF_PLATFORM_PATTERNS: RegExp[] = [
  /whats\s?app/i,
  /\btele\s?gram\b/i,
  /\bt\.me\//i,
  /\bsignal\s?(app|me)?\b/i,
  /\bwe\s?chat\b/i,
  /\bviber\b/i,
  /\bkik\b/i,
  /\bskype\b/i,
  /\b(hangouts|google\s?chat)\b/i,
  /\b(text|message|contact|reach|add|call)\s+me\s+(on|at|via)\b/i,
  /\b(let'?s|lets|we)\s+(talk|chat|move|continue|take this)\b.*\b(off|another|different|outside)\b/i,
  /\bmy\s+(number|whatsapp|telegram|handle)\b/i,
];

// Money / crypto / investment asks.
const MONEY_PATTERNS: RegExp[] = [
  /\b(bit\s?coin|btc|ethereum|eth|usdt|tether|crypto(currency)?|binance|coinbase)\b/i,
  /\b(forex|day\s?trad(e|ing)|trading\s?(signal|platform|account)|invest(ment|ing|or)?)\b/i,
  /\b(gift\s?card|steam\s?card|itunes\s?card)\b/i,
  /\b(western\s?union|money\s?gram|wire\s?transfer)\b/i,
  /\b(cash\s?app|\$cashtag|venmo|zelle|paypal(\.me)?|revolut|wise)\b/i,
  /\b(send|transfer|wire|deposit|invest|borrow|lend|loan)\s+(me\s+)?(some\s+)?(money|funds|cash|\$?\d)/i,
  /\b(guaranteed|double\s+your|huge)\s+(profit|return|roi)\b/i,
  /\b0x[a-f0-9]{40}\b/i,                 // ETH wallet address
  /\b(bc1|[13])[a-z0-9]{25,39}\b/i,      // BTC wallet address
];

// Phone numbers (7+ digits, allowing spaces / dashes / dots / +).
const PHONE_PATTERN = /(\+?\d[\d\s().-]{6,}\d)/;

function anyMatch(patterns: RegExp[], raw: string, norm: string): boolean {
  return patterns.some((re) => re.test(raw) || re.test(norm));
}

export interface ScamDetectionResult {
  /** Strong scam signals — trigger the recipient-facing warning banner. */
  warn: boolean;
  /** All matched categories — persisted on the flag for review. */
  categories: ScamCategory[];
}

/**
 * Inspect a chat message body for scam signals. Pure + synchronous so it
 * can run inline on the fire-and-forget path with no I/O.
 */
export function detectScamSignals(text: string | null | undefined): ScamDetectionResult {
  if (!text || text.length < 3) return { warn: false, categories: [] };
  const raw = text;
  const norm = normalize(text);

  const categories: ScamCategory[] = [];
  if (anyMatch(OFF_PLATFORM_PATTERNS, raw, norm)) categories.push('OFF_PLATFORM');
  if (anyMatch(MONEY_PATTERNS, raw, norm)) categories.push('MONEY');
  if (PHONE_PATTERN.test(raw)) categories.push('CONTACT');

  // A phone number alone is common between real matches, so it flags for
  // review but does NOT raise the banner. OFF_PLATFORM / MONEY do.
  const warn = categories.includes('OFF_PLATFORM') || categories.includes('MONEY');
  return { warn, categories };
}
