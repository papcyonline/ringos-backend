import { describe, it, expect } from 'vitest';

// We need the MoodTag enum values. Since Prisma client is generated,
// we mock the @prisma/client module to provide the enum.
import { vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  MoodTag: {
    HAPPY: 'HAPPY',
    SAD: 'SAD',
    ANXIOUS: 'ANXIOUS',
    LONELY: 'LONELY',
    ANGRY: 'ANGRY',
    NEUTRAL: 'NEUTRAL',
    EXCITED: 'EXCITED',
    TIRED: 'TIRED',
    OVERWHELMED: 'OVERWHELMED',
    HOPEFUL: 'HOPEFUL',
  },
}));

import { extractMood } from '../emotion.service';

describe('emotion.service — extractMood', () => {
  // ── Exact MoodTag matches ─────────────────────────────────────────

  describe('exact MoodTag matches', () => {
    it.each([
      ['HAPPY', 'HAPPY'],
      ['SAD', 'SAD'],
      ['ANXIOUS', 'ANXIOUS'],
      ['LONELY', 'LONELY'],
      ['ANGRY', 'ANGRY'],
      ['NEUTRAL', 'NEUTRAL'],
      ['EXCITED', 'EXCITED'],
      ['TIRED', 'TIRED'],
      ['OVERWHELMED', 'OVERWHELMED'],
      ['HOPEFUL', 'HOPEFUL'],
    ])('should return %s for exact input "%s"', (input, expected) => {
      expect(extractMood(input)).toBe(expected);
    });
  });

  // ── Case insensitivity ────────────────────────────────────────────

  describe('case insensitivity', () => {
    it('should handle lowercase input', () => {
      expect(extractMood('happy')).toBe('HAPPY');
    });

    it('should handle mixed case input', () => {
      expect(extractMood('Happy')).toBe('HAPPY');
    });

    it('should handle all-caps input', () => {
      expect(extractMood('SAD')).toBe('SAD');
    });
  });

  // ── Whitespace trimming ───────────────────────────────────────────

  describe('whitespace trimming', () => {
    it('should trim leading whitespace', () => {
      expect(extractMood('  HAPPY')).toBe('HAPPY');
    });

    it('should trim trailing whitespace', () => {
      expect(extractMood('ANGRY  ')).toBe('ANGRY');
    });

    it('should trim both leading and trailing whitespace', () => {
      expect(extractMood('  TIRED  ')).toBe('TIRED');
    });
  });

  // ── Fuzzy mappings — HAPPY ────────────────────────────────────────

  describe('fuzzy mappings to HAPPY', () => {
    it.each(['HAPPINESS', 'JOY', 'JOYFUL', 'CHEERFUL'])(
      'should map "%s" to HAPPY',
      (input) => {
        expect(extractMood(input)).toBe('HAPPY');
      },
    );
  });

  // ── Fuzzy mappings — SAD ──────────────────────────────────────────

  describe('fuzzy mappings to SAD', () => {
    it.each(['SADNESS', 'DEPRESSED', 'DOWN', 'UNHAPPY'])(
      'should map "%s" to SAD',
      (input) => {
        expect(extractMood(input)).toBe('SAD');
      },
    );
  });

  // ── Fuzzy mappings — ANXIOUS ──────────────────────────────────────

  describe('fuzzy mappings to ANXIOUS', () => {
    it.each(['ANXIETY', 'NERVOUS', 'WORRIED', 'STRESSED'])(
      'should map "%s" to ANXIOUS',
      (input) => {
        expect(extractMood(input)).toBe('ANXIOUS');
      },
    );
  });

  // ── Fuzzy mappings — LONELY ───────────────────────────────────────

  describe('fuzzy mappings to LONELY', () => {
    it.each(['ALONE', 'ISOLATED'])('should map "%s" to LONELY', (input) => {
      expect(extractMood(input)).toBe('LONELY');
    });
  });

  // ── Fuzzy mappings — ANGRY ────────────────────────────────────────

  describe('fuzzy mappings to ANGRY', () => {
    it.each(['RAGE', 'FRUSTRATED', 'MAD', 'IRRITATED'])(
      'should map "%s" to ANGRY',
      (input) => {
        expect(extractMood(input)).toBe('ANGRY');
      },
    );
  });

  // ── Fuzzy mappings — NEUTRAL ──────────────────────────────────────

  describe('fuzzy mappings to NEUTRAL', () => {
    it.each(['CALM', 'CONTENT', 'FINE'])('should map "%s" to NEUTRAL', (input) => {
      expect(extractMood(input)).toBe('NEUTRAL');
    });
  });

  // ── Fuzzy mappings — EXCITED ──────────────────────────────────────

  describe('fuzzy mappings to EXCITED', () => {
    it.each(['THRILLED', 'ENTHUSIASTIC', 'PUMPED'])(
      'should map "%s" to EXCITED',
      (input) => {
        expect(extractMood(input)).toBe('EXCITED');
      },
    );
  });

  // ── Fuzzy mappings — TIRED ────────────────────────────────────────

  describe('fuzzy mappings to TIRED', () => {
    it.each(['EXHAUSTED', 'SLEEPY', 'FATIGUED', 'DRAINED'])(
      'should map "%s" to TIRED',
      (input) => {
        expect(extractMood(input)).toBe('TIRED');
      },
    );
  });

  // ── Fuzzy mappings — OVERWHELMED ──────────────────────────────────

  describe('fuzzy mappings to OVERWHELMED', () => {
    it.each(['STRESSED_OUT', 'SWAMPED'])(
      'should map "%s" to OVERWHELMED',
      (input) => {
        expect(extractMood(input)).toBe('OVERWHELMED');
      },
    );
  });

  // ── Fuzzy mappings — HOPEFUL ──────────────────────────────────────

  describe('fuzzy mappings to HOPEFUL', () => {
    it.each(['OPTIMISTIC', 'POSITIVE', 'ENCOURAGED'])(
      'should map "%s" to HOPEFUL',
      (input) => {
        expect(extractMood(input)).toBe('HOPEFUL');
      },
    );
  });

  // ── Fuzzy with case insensitivity ─────────────────────────────────

  describe('fuzzy mappings are case-insensitive', () => {
    it('should map lowercase "happiness" to HAPPY', () => {
      expect(extractMood('happiness')).toBe('HAPPY');
    });

    it('should map mixed case "Sleepy" to TIRED', () => {
      expect(extractMood('Sleepy')).toBe('TIRED');
    });

    it('should map lowercase "optimistic" to HOPEFUL', () => {
      expect(extractMood('optimistic')).toBe('HOPEFUL');
    });
  });

  // ── Unknown moods default to NEUTRAL ──────────────────────────────

  describe('unknown moods default to NEUTRAL', () => {
    it('should return NEUTRAL for completely unknown input', () => {
      expect(extractMood('BAFFLED')).toBe('NEUTRAL');
    });

    it('should return NEUTRAL for gibberish input', () => {
      expect(extractMood('xyzzy123')).toBe('NEUTRAL');
    });

    it('should return NEUTRAL for empty-like input after trim', () => {
      // Note: empty string would be trimmed to "", toUpperCase() => ""
      // "" is not in validMoods or fuzzyMap, so → NEUTRAL
      expect(extractMood('')).toBe('NEUTRAL');
    });
  });
});
