import { prisma } from '../../config/database';
import { getIO } from '../../config/socket';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors';
import { broadcastAndNotifyMessage } from './chat.utils';

const MAX_QUESTION_LEN = 200;
const MAX_OPTION_LEN = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;

export interface CreatePollInput {
  conversationId: string;
  creatorId: string;
  question: string;
  options: string[];
  allowMultiple?: boolean;
}

/**
 * Create a poll anchored to a new Message. The message content is a fallback
 * string so old app versions without poll rendering see something readable.
 */
export async function createPoll(input: CreatePollInput) {
  const { conversationId, creatorId, question: rawQuestion, options: rawOptions } = input;
  const allowMultiple = !!input.allowMultiple;

  const question = rawQuestion.trim();
  if (!question || question.length > MAX_QUESTION_LEN) {
    throw new BadRequestError(`Question must be 1-${MAX_QUESTION_LEN} chars`);
  }

  const cleaned = rawOptions.map((s) => (s ?? '').trim()).filter(Boolean);
  if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) {
    throw new BadRequestError(`Poll must have ${MIN_OPTIONS}-${MAX_OPTIONS} options`);
  }
  for (const opt of cleaned) {
    if (opt.length > MAX_OPTION_LEN) {
      throw new BadRequestError(`Each option must be ≤ ${MAX_OPTION_LEN} chars`);
    }
  }

  // Confirm sender is a non-left participant
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: creatorId } },
    select: { leftAt: true },
  });
  if (!participant || participant.leftAt) {
    throw new ForbiddenError('Not a participant of this conversation');
  }

  // Enforce announcement mode if enabled
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { adminsOnlyMessages: true, type: true },
  });
  if (!conversation) throw new NotFoundError('Conversation not found');
  if (conversation.type === 'GROUP' && conversation.adminsOnlyMessages) {
    const p = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: creatorId } },
      select: { role: true },
    });
    if (p?.role !== 'ADMIN') {
      throw new ForbiddenError('Only admins can send messages in this group');
    }
  }

  const fallbackContent = `\uD83D\uDCCA ${question}`;

  const { message, poll } = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: creatorId,
        content: fallbackContent,
        metadata: { type: 'poll' },
      },
      include: {
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
        replyTo: { include: { sender: { select: { displayName: true } } } },
        reactions: { include: { user: { select: { displayName: true } } } },
      },
    });

    const poll = await tx.poll.create({
      data: {
        conversationId,
        messageId: message.id,
        creatorId,
        question,
        allowMultiple,
        options: {
          create: cleaned.map((text, idx) => ({ text, orderIdx: idx })),
        },
      },
      include: { options: { orderBy: { orderIdx: 'asc' } } },
    });

    // Backfill message metadata with pollId now that we have it
    await tx.message.update({
      where: { id: message.id },
      data: { metadata: { type: 'poll', pollId: poll.id } },
    });

    return { message, poll };
  });

  // Broadcast as a regular chat message + list update
  const enriched = { ...message, metadata: { type: 'poll', pollId: poll.id } };
  broadcastAndNotifyMessage(enriched, conversationId, creatorId);

  return getPollDetails(poll.id, creatorId);
}

/**
 * Aggregated poll view: options with vote counts + whether current user voted.
 * Also includes voter IDs per option so clients can show "who voted" on tap.
 */
export async function getPollDetails(pollId: string, viewerId: string) {
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: {
      options: {
        orderBy: { orderIdx: 'asc' },
        include: {
          votes: {
            select: {
              voterId: true,
              voter: { select: { id: true, displayName: true, avatarUrl: true } },
            },
          },
        },
      },
    },
  });
  if (!poll) throw new NotFoundError('Poll not found');

  // Only participants of the conversation can read the poll
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: poll.conversationId, userId: viewerId } },
    select: { leftAt: true },
  });
  if (!participant) throw new ForbiddenError('Not a participant');

  return {
    id: poll.id,
    conversationId: poll.conversationId,
    messageId: poll.messageId,
    creatorId: poll.creatorId,
    question: poll.question,
    allowMultiple: poll.allowMultiple,
    closedAt: poll.closedAt,
    createdAt: poll.createdAt,
    totalVotes: poll.options.reduce((sum, o) => sum + o.votes.length, 0),
    options: poll.options.map((o) => ({
      id: o.id,
      text: o.text,
      orderIdx: o.orderIdx,
      voteCount: o.votes.length,
      votedByMe: o.votes.some((v) => v.voterId === viewerId),
      voters: o.votes.map((v) => ({
        id: v.voter.id,
        displayName: v.voter.displayName,
        avatarUrl: v.voter.avatarUrl,
      })),
    })),
  };
}

/**
 * Cast votes. If allowMultiple is false, previous votes for this poll by the
 * same user are replaced. If true, optionIds is additive (idempotent) and any
 * option IDs not included here are REMOVED (acts like "set of selected").
 */
export async function vote(pollId: string, voterId: string, optionIds: string[]) {
  if (!Array.isArray(optionIds) || optionIds.length === 0) {
    throw new BadRequestError('At least one option is required');
  }
  const uniqueOptionIds = Array.from(new Set(optionIds));

  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    select: {
      id: true,
      conversationId: true,
      closedAt: true,
      allowMultiple: true,
      options: { select: { id: true } },
    },
  });
  if (!poll) throw new NotFoundError('Poll not found');
  if (poll.closedAt) throw new BadRequestError('Poll is closed');

  const validIds = new Set(poll.options.map((o) => o.id));
  for (const id of uniqueOptionIds) {
    if (!validIds.has(id)) throw new BadRequestError('Invalid option id');
  }
  if (!poll.allowMultiple && uniqueOptionIds.length > 1) {
    throw new BadRequestError('Only one option allowed');
  }

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: poll.conversationId, userId: voterId } },
    select: { leftAt: true },
  });
  if (!participant || participant.leftAt) {
    throw new ForbiddenError('Not a participant');
  }

  await prisma.$transaction(async (tx) => {
    // Replace existing votes with the new set (idempotent: "set of chosen").
    await tx.pollVote.deleteMany({
      where: {
        pollId,
        voterId,
        optionId: { notIn: uniqueOptionIds },
      },
    });
    for (const optionId of uniqueOptionIds) {
      await tx.pollVote.upsert({
        where: { optionId_voterId: { optionId, voterId } },
        create: { pollId, optionId, voterId },
        update: {},
      });
    }
  });

  const details = await getPollDetails(pollId, voterId);
  // Emit aggregated update to all participants — they'll refresh their poll card
  getIO()
    .to(`conversation:${poll.conversationId}`)
    .emit('chat:poll-updated', details);
  return details;
}

/**
 * Only the poll creator can close a poll. After close, no more votes accepted.
 */
export async function closePoll(pollId: string, userId: string) {
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    select: { creatorId: true, conversationId: true, closedAt: true },
  });
  if (!poll) throw new NotFoundError('Poll not found');
  if (poll.creatorId !== userId) throw new ForbiddenError('Only the poll creator can close it');
  if (poll.closedAt) return getPollDetails(pollId, userId);

  await prisma.poll.update({
    where: { id: pollId },
    data: { closedAt: new Date() },
  });

  const details = await getPollDetails(pollId, userId);
  getIO()
    .to(`conversation:${poll.conversationId}`)
    .emit('chat:poll-updated', details);
  return details;
}
