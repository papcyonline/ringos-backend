import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { calculateMatchScore, findBestMatch, MatchCandidate } from './matching.algorithm';
import { CreateMatchRequestInput } from './matching.schema';

// ─── Create a new match request ─────────────────────────

export async function createMatchRequest(userId: string, data: CreateMatchRequestInput) {
  // Check user is not banned
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { preference: true },
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (user.banStatus === 'TEMP_BAN' || user.banStatus === 'PERMANENT_BAN') {
    const isTempExpired =
      user.banStatus === 'TEMP_BAN' && user.banExpiresAt && user.banExpiresAt < new Date();
    if (!isTempExpired) {
      throw new ForbiddenError('Your account is currently banned from matching');
    }
  }

  // Check no active (WAITING) request exists
  const existingRequest = await prisma.matchRequest.findFirst({
    where: { userId, status: 'WAITING' },
  });

  if (existingRequest) {
    throw new ConflictError('You already have an active match request');
  }

  // Build the match request from user data + input
  const preference = user.preference;
  const matchRequest = await prisma.matchRequest.create({
    data: {
      userId,
      intent: data.intent,
      mood: data.mood ?? preference?.mood ?? 'NEUTRAL',
      language: preference?.language ?? 'en',
      timezone: preference?.timezone ?? 'UTC',
      topics: data.topics ?? preference?.topics ?? [],
      fromAiSession: data.fromAiSession ?? null,
      status: 'WAITING',
    },
  });

  logger.info({ requestId: matchRequest.id, userId, intent: data.intent }, 'Match request created');

  // Attempt to find a match immediately
  const matchResult = await attemptMatch(matchRequest);

  return { request: matchRequest, matchResult };
}

// ─── Attempt to match a request ─────────────────────────

export async function attemptMatch(request: {
  id: string;
  userId: string;
  intent: string;
  mood: string;
  language: string;
  timezone: string;
  topics: string[];
}) {
  // Find all blocked user IDs (in both directions)
  const blocks = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: request.userId }, { blockedId: request.userId }],
    },
    select: { blockerId: true, blockedId: true },
  });

  const blockedUserIds = new Set<string>();
  for (const block of blocks) {
    blockedUserIds.add(block.blockerId);
    blockedUserIds.add(block.blockedId);
  }
  blockedUserIds.delete(request.userId); // Remove self

  // Find all WAITING requests excluding user's own and blocked users
  const waitingRequests = await prisma.matchRequest.findMany({
    where: {
      status: 'WAITING',
      id: { not: request.id },
      userId: {
        notIn: [request.userId, ...Array.from(blockedUserIds)],
      },
    },
  });

  if (waitingRequests.length === 0) {
    logger.debug({ requestId: request.id }, 'No candidates available for matching');
    return null;
  }

  // Map DB records to MatchCandidate shape
  const requestCandidate: MatchCandidate = {
    id: request.id,
    userId: request.userId,
    intent: request.intent,
    mood: request.mood,
    language: request.language,
    timezone: request.timezone,
    topics: request.topics,
  };

  const candidates: MatchCandidate[] = waitingRequests.map((r) => ({
    id: r.id,
    userId: r.userId,
    intent: r.intent,
    mood: r.mood,
    language: r.language,
    timezone: r.timezone,
    topics: r.topics,
  }));

  const result = findBestMatch(requestCandidate, candidates);

  if (!result) {
    logger.debug({ requestId: request.id }, 'No suitable match found above threshold');
    return null;
  }

  const { match, score } = result;

  // Update both requests to MATCHED
  await prisma.$transaction([
    prisma.matchRequest.update({
      where: { id: request.id },
      data: { status: 'MATCHED', matchedWith: match.userId },
    }),
    prisma.matchRequest.update({
      where: { id: match.id },
      data: { status: 'MATCHED', matchedWith: request.userId },
    }),
  ]);

  // Create the conversation with both participants
  const conversation = await prisma.conversation.create({
    data: {
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      metadata: { matchScore: score, intent: request.intent },
      participants: {
        create: [{ userId: request.userId }, { userId: match.userId }],
      },
    },
    include: {
      participants: {
        include: { user: { select: { id: true, displayName: true } } },
      },
    },
  });

  logger.info(
    {
      requestId: request.id,
      matchedRequestId: match.id,
      conversationId: conversation.id,
      score,
    },
    'Match found and conversation created',
  );

  return {
    conversation,
    matchedUserId: match.userId,
    requestUserId: request.userId,
    score,
  };
}

// ─── Cancel a waiting request ───────────────────────────

export async function cancelMatchRequest(requestId: string, userId: string) {
  const request = await prisma.matchRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new NotFoundError('Match request not found');
  }

  if (request.userId !== userId) {
    throw new ForbiddenError('You can only cancel your own requests');
  }

  if (request.status !== 'WAITING') {
    throw new BadRequestError('Only waiting requests can be cancelled');
  }

  const cancelled = await prisma.matchRequest.update({
    where: { id: requestId },
    data: { status: 'CANCELLED' },
  });

  logger.info({ requestId, userId }, 'Match request cancelled');

  return cancelled;
}

// ─── Get user's active waiting request ──────────────────

export async function getActiveRequest(userId: string) {
  const request = await prisma.matchRequest.findFirst({
    where: { userId, status: 'WAITING' },
    orderBy: { createdAt: 'desc' },
  });

  return request;
}
