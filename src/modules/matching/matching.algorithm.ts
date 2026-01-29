// ─── Types ──────────────────────────────────────────────

export interface MatchCandidate {
  id: string;
  userId: string;
  intent: string;
  mood: string;
  language: string;
  timezone: string;
  topics: string[];
}

// ─── Intent compatibility ───────────────────────────────

type IntentPair = `${string}+${string}`;

const INTENT_EXACT_SCORE = 40;
const INTENT_COMPATIBLE_SCORE = 30;
const INTENT_PARTIAL_SCORE = 15;

const compatibleIntents = new Set<IntentPair>([
  'VENT+JUST_LISTEN',
  'JUST_LISTEN+VENT',
  'ADVICE+DEEP_TALK',
  'DEEP_TALK+ADVICE',
]);

const partiallyCompatibleIntents = new Set<IntentPair>([
  'VENT+ADVICE',
  'ADVICE+VENT',
  'CASUAL_CHAT+JUST_LISTEN',
  'JUST_LISTEN+CASUAL_CHAT',
  'CASUAL_CHAT+DEEP_TALK',
  'DEEP_TALK+CASUAL_CHAT',
  'DEEP_TALK+JUST_LISTEN',
  'JUST_LISTEN+DEEP_TALK',
]);

function scoreIntent(intent1: string, intent2: string): number {
  if (intent1 === intent2) return INTENT_EXACT_SCORE;
  const pair: IntentPair = `${intent1}+${intent2}`;
  if (compatibleIntents.has(pair)) return INTENT_COMPATIBLE_SCORE;
  if (partiallyCompatibleIntents.has(pair)) return INTENT_PARTIAL_SCORE;
  return 0;
}

// ─── Mood compatibility ─────────────────────────────────

const MOOD_MAX = 25;

const moodMatrix: Record<string, number> = {
  // High compatibility pairs
  'SAD+HOPEFUL': 25,
  'HOPEFUL+SAD': 25,
  'HAPPY+HAPPY': 25,
  'HAPPY+EXCITED': 25,
  'EXCITED+HAPPY': 25,
  'EXCITED+EXCITED': 25,
  'LONELY+LONELY': 20,
  'SAD+SAD': 20,
  'ANXIOUS+NEUTRAL': 20,
  'NEUTRAL+ANXIOUS': 20,
  'OVERWHELMED+HOPEFUL': 22,
  'HOPEFUL+OVERWHELMED': 22,
  'OVERWHELMED+NEUTRAL': 18,
  'NEUTRAL+OVERWHELMED': 18,
  'LONELY+HOPEFUL': 22,
  'HOPEFUL+LONELY': 22,
  'ANGRY+NEUTRAL': 18,
  'NEUTRAL+ANGRY': 18,
  'TIRED+NEUTRAL': 18,
  'NEUTRAL+TIRED': 18,
  'NEUTRAL+NEUTRAL': 20,
  'HOPEFUL+HOPEFUL': 25,
  'TIRED+TIRED': 18,
  'ANXIOUS+HOPEFUL': 22,
  'HOPEFUL+ANXIOUS': 22,
  'ANXIOUS+ANXIOUS': 15,
  'ANGRY+ANGRY': 12,
  'SAD+LONELY': 18,
  'LONELY+SAD': 18,
  'TIRED+HOPEFUL': 20,
  'HOPEFUL+TIRED': 20,
};

function scoreMood(mood1: string, mood2: string): number {
  const key = `${mood1}+${mood2}`;
  return moodMatrix[key] ?? 10;
}

// ─── Language match ─────────────────────────────────────

function scoreLanguage(lang1: string, lang2: string): number {
  return lang1.toLowerCase() === lang2.toLowerCase() ? 20 : 0;
}

// ─── Timezone proximity ─────────────────────────────────

function parseTimezoneOffset(tz: string): number {
  // Attempt to compute the offset in hours from a timezone string.
  // Accepts IANA timezone names or UTC offset strings like "UTC+5" / "UTC-3".
  const utcOffsetMatch = tz.match(/^UTC([+-]\d{1,2})$/i);
  if (utcOffsetMatch) {
    return parseInt(utcOffsetMatch[1], 10);
  }
  try {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    const offsetPart = formatted.find((p) => p.type === 'timeZoneName');
    if (offsetPart) {
      const match = offsetPart.value.match(/GMT([+-]?\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  } catch {
    // Fall through to default
  }
  return 0;
}

function scoreTimezone(tz1: string, tz2: string): number {
  if (tz1 === tz2) return 10;
  const offset1 = parseTimezoneOffset(tz1);
  const offset2 = parseTimezoneOffset(tz2);
  const diff = Math.abs(offset1 - offset2);
  if (diff <= 3) return 7;
  if (diff <= 6) return 3;
  return 0;
}

// ─── Topic overlap ──────────────────────────────────────

function scoreTopics(topics1: string[], topics2: string[]): number {
  if (topics1.length === 0 || topics2.length === 0) return 0;
  const set1 = new Set(topics1.map((t) => t.toLowerCase()));
  const shared = topics2.filter((t) => set1.has(t.toLowerCase())).length;
  const maxTopics = Math.max(topics1.length, topics2.length);
  return (shared / maxTopics) * 5;
}

// ─── Public API ─────────────────────────────────────────

export function calculateMatchScore(request1: MatchCandidate, request2: MatchCandidate): number {
  const intentScore = scoreIntent(request1.intent, request2.intent);
  const moodScore = scoreMood(request1.mood, request2.mood);
  const languageScore = scoreLanguage(request1.language, request2.language);
  const timezoneScore = scoreTimezone(request1.timezone, request2.timezone);
  const topicScore = scoreTopics(request1.topics, request2.topics);

  return Math.min(100, intentScore + moodScore + languageScore + timezoneScore + topicScore);
}

export function findBestMatch(
  request: MatchCandidate,
  candidates: MatchCandidate[],
): { match: MatchCandidate; score: number } | null {
  const MINIMUM_SCORE = 30;
  let bestMatch: MatchCandidate | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = calculateMatchScore(request, candidate);
    if (score >= MINIMUM_SCORE && score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestMatch ? { match: bestMatch, score: bestScore } : null;
}
