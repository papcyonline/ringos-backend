import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, BadRequestError } from '../../shared/errors';
import { MatchIntent, MoodTag } from '@prisma/client';

function deriveIntentFromMood(mood: string): MatchIntent {
  const upper = mood.toUpperCase();
  switch (upper) {
    case 'SAD':
    case 'LONELY':
      return 'VENT';
    case 'ANXIOUS':
      return 'ADVICE';
    default:
      return 'CASUAL_CHAT';
  }
}

export async function createHandoffRequest(
  userId: string,
  aiSessionId: string,
  mood?: string,
  intent?: string,
) {
  // Verify the AI session exists, belongs to the user, and is active
  const session = await prisma.aiSession.findUnique({
    where: { id: aiSessionId },
  });

  if (!session) {
    throw new NotFoundError('AI session not found');
  }

  if (session.userId !== userId) {
    throw new BadRequestError('AI session does not belong to this user');
  }

  if (session.status !== 'ACTIVE') {
    throw new BadRequestError('AI session is not active');
  }

  // End the AI session
  await prisma.aiSession.update({
    where: { id: aiSessionId },
    data: { status: 'ENDED' },
  });

  // Derive intent from mood, or use provided intent, or default
  let matchIntent: MatchIntent;
  if (intent && Object.values(MatchIntent).includes(intent.toUpperCase() as MatchIntent)) {
    matchIntent = intent.toUpperCase() as MatchIntent;
  } else if (mood) {
    matchIntent = deriveIntentFromMood(mood);
  } else {
    matchIntent = 'CASUAL_CHAT';
  }

  // Determine mood tag
  const moodTag: MoodTag =
    mood && Object.values(MoodTag).includes(mood.toUpperCase() as MoodTag)
      ? (mood.toUpperCase() as MoodTag)
      : 'NEUTRAL';

  // Fetch user preferences for language/timezone/topics
  const preference = await prisma.userPreference.findUnique({
    where: { userId },
  });

  // Create a match request with fromAiSession set
  const matchRequest = await prisma.matchRequest.create({
    data: {
      userId,
      intent: matchIntent,
      mood: moodTag,
      language: preference?.language ?? 'en',
      timezone: preference?.timezone ?? 'UTC',
      topics: preference?.topics ?? [],
      fromAiSession: aiSessionId,
    },
  });

  logger.info(
    { userId, aiSessionId, matchRequestId: matchRequest.id, intent: matchIntent },
    'AI-to-human handoff initiated',
  );

  return {
    matchRequestId: matchRequest.id,
    intent: matchRequest.intent,
    mood: matchRequest.mood,
    status: matchRequest.status,
    fromAiSession: matchRequest.fromAiSession,
  };
}
