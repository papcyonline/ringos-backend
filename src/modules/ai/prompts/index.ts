import { CompanionMode } from '@prisma/client';
import { calmListenerPrompt } from './calm-listener';
import { lightAndFunPrompt } from './light-and-fun';
import { nightCompanionPrompt } from './night-companion';
import { motivatorPrompt } from './motivator';
import { relationshipCoachPrompt } from './relationship-coach';
import { careerMentorPrompt } from './career-mentor';

export const promptMap: Record<CompanionMode, string> = {
  CALM_LISTENER: calmListenerPrompt,
  LIGHT_AND_FUN: lightAndFunPrompt,
  NIGHT_COMPANION: nightCompanionPrompt,
  MOTIVATOR: motivatorPrompt,
  RELATIONSHIP_COACH: relationshipCoachPrompt,
  CAREER_MENTOR: careerMentorPrompt,
};
