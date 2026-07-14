// Lightweight text content filter. Kept SEPARATE from moderation.service (which
// pulls in TensorFlow + NSFWJS) so text-only paths — username/bio validation in
// auth/user schemas — don't drag the native ML stack into their import graph.

// Common leet-speak substitutions applied before checking so people
// can't bypass the filter with "s3x" or "p0rn".
function normalizeLeet(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
}

// Patterns use word boundaries (\b) where the term could appear as a
// substring of innocent words (e.g. "ass" in "classic"), and no boundary
// where the prefix is always explicit (e.g. "ejaculat-").
const EXPLICIT_PATTERNS: RegExp[] = [
  /\bporn(ography|ographic|hub|star)?\b/,
  /\bxxx\b/,
  /\bnudes?\b/,
  /\bsexting\b/,
  /\bfuck(ing|er|s)?\b/,
  /\bcunt\b/,
  /\bcock\b/,
  /\bdick(s)?\b/,
  /\bpussy\b/,
  /\bboobs?\b/,
  /\btits?\b/,
  /\basshole\b/,
  /ejaculat/,
  /\bdildo\b/,
  /\bprostitut(e|ion)?\b/,
  /\bbdsm\b/,
  /\bblowjob\b/,
  /\bhandjob\b/,
  /\bhooker\b/,
  /\bwhore\b/,
  /\bslut\b/,
  /\bhorny\b/,
  /\bstripper\b/,
  /\bcumshot\b/,
  /\bfetish\b/,
  /\bonlyfans\b/,
  /\bmilf\b/,
  /\bshemale\b/,
  /\bsex.?worker\b/,
  /\berotic(a)?\b/,
  /\bncest\b/,
  /\bpedophil/,
];

/**
 * Returns true when the text contains explicit sexual content or porn
 * references — including common leet-speak obfuscations.
 */
export function containsExplicitText(text: string): boolean {
  const normalized = normalizeLeet(text);
  return EXPLICIT_PATTERNS.some((p) => p.test(normalized));
}
