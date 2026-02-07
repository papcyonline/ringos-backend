import { describe, it, expect } from 'vitest';
import { calculateMatchScore, findBestMatch, MatchCandidate } from '../matching.algorithm';

// ── Helper to create a MatchCandidate with defaults ──────────────────

function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: 'req-1',
    userId: 'user-1',
    intent: 'CASUAL_CHAT',
    mood: 'NEUTRAL',
    language: 'en',
    timezone: 'UTC+0',
    topics: [],
    ...overrides,
  };
}

describe('matching.algorithm', () => {
  // ── Intent scoring ─────────────────────────────────────────────────

  describe('intent scoring', () => {
    it('should score 40 for exact intent match', () => {
      const a = makeCandidate({ intent: 'VENT', mood: 'NEUTRAL', language: 'xx', topics: [] });
      const b = makeCandidate({ intent: 'VENT', mood: 'NEUTRAL', language: 'yy', topics: [] });
      // intent=40, mood=default(NEUTRAL+NEUTRAL)=20, lang=0, tz=(same)=10, topics=0 => 70
      // We test intent contribution by comparing same vs different
      const sameIntent = calculateMatchScore(a, b);
      const diffIntent = calculateMatchScore(a, makeCandidate({ intent: 'ADVICE', mood: 'NEUTRAL', language: 'yy', topics: [] }));
      expect(sameIntent - diffIntent).toBeGreaterThanOrEqual(25); // 40 vs 15 (partial) or 0
    });

    it('should score 30 for VENT + JUST_LISTEN compatible pair', () => {
      const a = makeCandidate({ intent: 'VENT' });
      const b = makeCandidate({ intent: 'JUST_LISTEN' });
      const score = calculateMatchScore(a, b);
      // intent=30, mood=20, lang=20, tz=10, topics=0 => 80
      expect(score).toBe(80);
    });

    it('should score 30 for JUST_LISTEN + VENT (reverse)', () => {
      const a = makeCandidate({ intent: 'JUST_LISTEN' });
      const b = makeCandidate({ intent: 'VENT' });
      const score = calculateMatchScore(a, b);
      expect(score).toBe(80);
    });

    it('should score 30 for ADVICE + DEEP_TALK compatible pair', () => {
      const a = makeCandidate({ intent: 'ADVICE' });
      const b = makeCandidate({ intent: 'DEEP_TALK' });
      const score = calculateMatchScore(a, b);
      expect(score).toBe(80);
    });

    it('should score 15 for partially compatible VENT + ADVICE', () => {
      const a = makeCandidate({ intent: 'VENT' });
      const b = makeCandidate({ intent: 'ADVICE' });
      const score = calculateMatchScore(a, b);
      // intent=15, mood=20, lang=20, tz=10, topics=0 => 65
      expect(score).toBe(65);
    });

    it('should score 15 for partially compatible CASUAL_CHAT + DEEP_TALK', () => {
      const a = makeCandidate({ intent: 'CASUAL_CHAT' });
      const b = makeCandidate({ intent: 'DEEP_TALK' });
      const score = calculateMatchScore(a, b);
      expect(score).toBe(65);
    });

    it('should score 0 for incompatible intents', () => {
      const a = makeCandidate({ intent: 'VENT', language: 'xx' });
      const b = makeCandidate({ intent: 'CASUAL_CHAT', language: 'yy' });
      // intent=0, mood=20, lang=0, tz=10, topics=0 => 30
      const score = calculateMatchScore(a, b);
      expect(score).toBe(30);
    });
  });

  // ── Mood scoring ───────────────────────────────────────────────────

  describe('mood scoring', () => {
    it('should score 25 for HAPPY + HAPPY', () => {
      const a = makeCandidate({ mood: 'HAPPY', language: 'xx' });
      const b = makeCandidate({ mood: 'HAPPY', language: 'yy' });
      const score1 = calculateMatchScore(a, b);
      const aNeut = makeCandidate({ mood: 'NEUTRAL', language: 'xx' });
      const bNeut = makeCandidate({ mood: 'NEUTRAL', language: 'yy' });
      const score2 = calculateMatchScore(aNeut, bNeut);
      // HAPPY+HAPPY=25, NEUTRAL+NEUTRAL=20, difference = 5
      expect(score1 - score2).toBe(5);
    });

    it('should score 25 for SAD + HOPEFUL', () => {
      const a = makeCandidate({ mood: 'SAD', intent: 'VENT', language: 'xx', topics: [] });
      const b = makeCandidate({ mood: 'HOPEFUL', intent: 'VENT', language: 'xx', topics: [] });
      // intent=40, mood=25, lang=20, tz=10, topics=0 => 95
      const score = calculateMatchScore(a, b);
      expect(score).toBe(95);
    });

    it('should score 12 for ANGRY + ANGRY', () => {
      const a = makeCandidate({ mood: 'ANGRY', intent: 'VENT', language: 'en' });
      const b = makeCandidate({ mood: 'ANGRY', intent: 'VENT', language: 'en' });
      // intent=40, mood=12, lang=20, tz=10, topics=0 => 82
      const score = calculateMatchScore(a, b);
      expect(score).toBe(82);
    });

    it('should default to 10 for unknown mood pairs', () => {
      const a = makeCandidate({ mood: 'HAPPY', intent: 'VENT', language: 'en' });
      const b = makeCandidate({ mood: 'ANGRY', intent: 'VENT', language: 'en' });
      // HAPPY+ANGRY is not in the matrix, defaults to 10
      // intent=40, mood=10, lang=20, tz=10, topics=0 => 80
      const score = calculateMatchScore(a, b);
      expect(score).toBe(80);
    });
  });

  // ── Language scoring ───────────────────────────────────────────────

  describe('language scoring', () => {
    it('should score 20 for exact language match', () => {
      const a = makeCandidate({ language: 'en' });
      const b = makeCandidate({ language: 'en' });
      const score = calculateMatchScore(a, b);
      // includes 20 from language
      const diffLang = calculateMatchScore(a, makeCandidate({ language: 'fr' }));
      expect(score - diffLang).toBe(20);
    });

    it('should score 0 for different languages', () => {
      const a = makeCandidate({ language: 'en' });
      const b = makeCandidate({ language: 'fr' });
      const sameLang = calculateMatchScore(a, makeCandidate({ language: 'en' }));
      const diffLang = calculateMatchScore(a, b);
      expect(sameLang - diffLang).toBe(20);
    });

    it('should be case-insensitive', () => {
      const a = makeCandidate({ language: 'EN' });
      const b = makeCandidate({ language: 'en' });
      const score = calculateMatchScore(a, b);
      const c = makeCandidate({ language: 'en' });
      const d = makeCandidate({ language: 'en' });
      const scoreExact = calculateMatchScore(c, d);
      expect(score).toBe(scoreExact);
    });
  });

  // ── Timezone scoring ───────────────────────────────────────────────

  describe('timezone scoring', () => {
    it('should score 10 for identical timezone strings', () => {
      const a = makeCandidate({ timezone: 'America/New_York' });
      const b = makeCandidate({ timezone: 'America/New_York' });
      const score = calculateMatchScore(a, b);
      // includes 10 from timezone
      const diffTz = calculateMatchScore(a, makeCandidate({ timezone: 'UTC+12' }));
      expect(score - diffTz).toBeGreaterThanOrEqual(7); // 10 vs 0 or 3
    });

    it('should score 7 for timezones within 3 hours', () => {
      const a = makeCandidate({ timezone: 'UTC+0', language: 'xx', intent: 'VENT', topics: [] });
      const b = makeCandidate({ timezone: 'UTC+2', language: 'xx', intent: 'VENT', topics: [] });
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=7, topics=0 => 87
      expect(score).toBe(87);
    });

    it('should score 3 for timezones within 4-6 hours', () => {
      const a = makeCandidate({ timezone: 'UTC+0', language: 'xx', intent: 'VENT', topics: [] });
      const b = makeCandidate({ timezone: 'UTC+5', language: 'xx', intent: 'VENT', topics: [] });
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=3, topics=0 => 83
      expect(score).toBe(83);
    });

    it('should score 0 for timezones more than 6 hours apart', () => {
      const a = makeCandidate({ timezone: 'UTC+0', language: 'xx', intent: 'VENT', topics: [] });
      const b = makeCandidate({ timezone: 'UTC+9', language: 'xx', intent: 'VENT', topics: [] });
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=0, topics=0 => 80
      expect(score).toBe(80);
    });

    it('should parse negative UTC offsets', () => {
      const a = makeCandidate({ timezone: 'UTC-5', language: 'xx', intent: 'VENT', topics: [] });
      const b = makeCandidate({ timezone: 'UTC-3', language: 'xx', intent: 'VENT', topics: [] });
      const score = calculateMatchScore(a, b);
      // diff=2 => tz=7
      // intent=40, mood=20, lang=20, tz=7, topics=0 => 87
      expect(score).toBe(87);
    });
  });

  // ── Topics scoring ─────────────────────────────────────────────────

  describe('topics scoring', () => {
    it('should score 0 when either topics array is empty', () => {
      const a = makeCandidate({ topics: ['art'], language: 'xx', intent: 'VENT' });
      const b = makeCandidate({ topics: [], language: 'xx', intent: 'VENT' });
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=10, topics=0 => 90
      expect(score).toBe(90);
    });

    it('should score based on overlap ratio * 5', () => {
      const a = makeCandidate({ topics: ['art', 'music', 'travel'], language: 'xx', intent: 'VENT' });
      const b = makeCandidate({ topics: ['art', 'music'], language: 'xx', intent: 'VENT' });
      // overlap = 2, max = 3, score = (2/3)*5 ≈ 3.33
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=10, topics≈3.33 => ≈93.33
      expect(score).toBeCloseTo(93.33, 1);
    });

    it('should score 5 for perfect topic overlap', () => {
      const a = makeCandidate({ topics: ['art', 'music'], language: 'xx', intent: 'VENT' });
      const b = makeCandidate({ topics: ['art', 'music'], language: 'xx', intent: 'VENT' });
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=10, topics=5 => 95
      expect(score).toBe(95);
    });

    it('should be case-insensitive for topics', () => {
      const a = makeCandidate({ topics: ['Art', 'MUSIC'], language: 'xx', intent: 'VENT' });
      const b = makeCandidate({ topics: ['art', 'music'], language: 'xx', intent: 'VENT' });
      const score = calculateMatchScore(a, b);
      // Same as perfect overlap
      expect(score).toBe(95);
    });

    it('should score 0 when topics have no overlap', () => {
      const a = makeCandidate({ topics: ['art'], language: 'xx', intent: 'VENT' });
      const b = makeCandidate({ topics: ['sports'], language: 'xx', intent: 'VENT' });
      const score = calculateMatchScore(a, b);
      // intent=40, mood=20, lang=20, tz=10, topics=0 => 90
      expect(score).toBe(90);
    });
  });

  // ── Composite score ────────────────────────────────────────────────

  describe('calculateMatchScore — composite', () => {
    it('should cap score at 100', () => {
      // Max possible: intent=40 + mood=25 + lang=20 + tz=10 + topics=5 = 100
      const a = makeCandidate({
        intent: 'VENT',
        mood: 'SAD',
        language: 'en',
        timezone: 'UTC+0',
        topics: ['art'],
      });
      const b = makeCandidate({
        intent: 'VENT',
        mood: 'HOPEFUL',
        language: 'en',
        timezone: 'UTC+0',
        topics: ['art'],
      });
      const score = calculateMatchScore(a, b);
      expect(score).toBeLessThanOrEqual(100);
      expect(score).toBe(100);
    });

    it('should return a number >= 0', () => {
      const a = makeCandidate({ intent: 'VENT', language: 'xx', mood: 'HAPPY', timezone: 'UTC+12' });
      const b = makeCandidate({ intent: 'CASUAL_CHAT', language: 'yy', mood: 'ANGRY', timezone: 'UTC-12' });
      const score = calculateMatchScore(a, b);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  // ── findBestMatch ──────────────────────────────────────────────────

  describe('findBestMatch', () => {
    it('should return the candidate with the highest score above threshold', () => {
      const request = makeCandidate({ intent: 'VENT', mood: 'SAD', language: 'en' });
      const candidates = [
        makeCandidate({ id: 'c1', intent: 'CASUAL_CHAT', mood: 'HAPPY', language: 'fr' }),
        makeCandidate({ id: 'c2', intent: 'VENT', mood: 'HOPEFUL', language: 'en' }),
        makeCandidate({ id: 'c3', intent: 'JUST_LISTEN', mood: 'NEUTRAL', language: 'en' }),
      ];
      const result = findBestMatch(request, candidates);
      expect(result).not.toBeNull();
      expect(result!.match.id).toBe('c2');
      expect(result!.score).toBeGreaterThan(30);
    });

    it('should return null when no candidates score >= 30', () => {
      const request = makeCandidate({ intent: 'VENT', mood: 'HAPPY', language: 'xx', timezone: 'UTC+12' });
      const candidates = [
        makeCandidate({
          id: 'c1',
          intent: 'CASUAL_CHAT',
          mood: 'ANGRY',
          language: 'yy',
          timezone: 'UTC-12',
          topics: [],
        }),
      ];
      // intent=0, mood=10, lang=0, tz=0, topics=0 => 10 < 30
      const result = findBestMatch(request, candidates);
      expect(result).toBeNull();
    });

    it('should return null for empty candidates array', () => {
      const request = makeCandidate();
      const result = findBestMatch(request, []);
      expect(result).toBeNull();
    });

    it('should include the score in the result', () => {
      const request = makeCandidate({ intent: 'VENT', language: 'en' });
      const candidates = [
        makeCandidate({ id: 'c1', intent: 'VENT', language: 'en' }),
      ];
      const result = findBestMatch(request, candidates);
      expect(result).not.toBeNull();
      expect(typeof result!.score).toBe('number');
      expect(result!.score).toBeGreaterThanOrEqual(30);
    });

    it('should pick the higher-scoring candidate when multiple qualify', () => {
      const request = makeCandidate({ intent: 'VENT', mood: 'SAD', language: 'en' });
      const candidates = [
        makeCandidate({ id: 'c1', intent: 'JUST_LISTEN', mood: 'NEUTRAL', language: 'en' }),
        makeCandidate({ id: 'c2', intent: 'VENT', mood: 'HOPEFUL', language: 'en' }),
      ];
      const result = findBestMatch(request, candidates);
      expect(result!.match.id).toBe('c2');
    });
  });
});
