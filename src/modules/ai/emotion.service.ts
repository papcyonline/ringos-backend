import { MoodTag } from '@prisma/client';

const validMoods = new Set<string>(Object.values(MoodTag));

export function extractMood(moodString: string): MoodTag {
  const normalized = moodString.toUpperCase().trim();

  if (validMoods.has(normalized)) {
    return normalized as MoodTag;
  }

  // Fuzzy mapping for common variations
  const fuzzyMap: Record<string, MoodTag> = {
    HAPPINESS: MoodTag.HAPPY,
    JOY: MoodTag.HAPPY,
    JOYFUL: MoodTag.HAPPY,
    CHEERFUL: MoodTag.HAPPY,
    SADNESS: MoodTag.SAD,
    DEPRESSED: MoodTag.SAD,
    DOWN: MoodTag.SAD,
    UNHAPPY: MoodTag.SAD,
    ANXIETY: MoodTag.ANXIOUS,
    NERVOUS: MoodTag.ANXIOUS,
    WORRIED: MoodTag.ANXIOUS,
    STRESSED: MoodTag.ANXIOUS,
    ALONE: MoodTag.LONELY,
    ISOLATED: MoodTag.LONELY,
    RAGE: MoodTag.ANGRY,
    FRUSTRATED: MoodTag.ANGRY,
    MAD: MoodTag.ANGRY,
    IRRITATED: MoodTag.ANGRY,
    CALM: MoodTag.NEUTRAL,
    CONTENT: MoodTag.NEUTRAL,
    FINE: MoodTag.NEUTRAL,
    THRILLED: MoodTag.EXCITED,
    ENTHUSIASTIC: MoodTag.EXCITED,
    PUMPED: MoodTag.EXCITED,
    EXHAUSTED: MoodTag.TIRED,
    SLEEPY: MoodTag.TIRED,
    FATIGUED: MoodTag.TIRED,
    DRAINED: MoodTag.TIRED,
    STRESSED_OUT: MoodTag.OVERWHELMED,
    SWAMPED: MoodTag.OVERWHELMED,
    OPTIMISTIC: MoodTag.HOPEFUL,
    POSITIVE: MoodTag.HOPEFUL,
    ENCOURAGED: MoodTag.HOPEFUL,
  };

  return fuzzyMap[normalized] ?? MoodTag.NEUTRAL;
}
