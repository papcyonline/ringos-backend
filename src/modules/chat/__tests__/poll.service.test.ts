import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockIO } = vi.hoisted(() => {
  const tx = vi.fn(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  const mockPrisma: any = {
    conversation: { findUnique: vi.fn() },
    conversationParticipant: { findUnique: vi.fn() },
    message: { create: vi.fn(), update: vi.fn() },
    poll: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    pollVote: { deleteMany: vi.fn(), upsert: vi.fn() },
    $transaction: tx,
  };
  const ioRoom = { emit: vi.fn() };
  const mockIO = { getIO: vi.fn(() => ({ to: vi.fn(() => ioRoom) })) };
  return { mockPrisma, mockIO };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/socket', () => mockIO);
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../chat.utils', () => ({
  broadcastAndNotifyMessage: vi.fn(),
}));

import { createPoll, getPollDetails, vote, closePoll } from '../poll.service';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
});

const baseInput = {
  conversationId: 'c-1',
  creatorId: 'user-1',
  question: 'What?',
  options: ['A', 'B'],
};

const pollFull = (over: Partial<any> = {}) => ({
  id: 'p-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  creatorId: 'user-1',
  question: 'What?',
  allowMultiple: false,
  closedAt: null,
  createdAt: new Date(),
  options: [
    { id: 'opt-1', text: 'A', orderIdx: 0, votes: [] },
    { id: 'opt-2', text: 'B', orderIdx: 1, votes: [] },
  ],
  ...over,
});

// ─── createPoll ──────────────────────────────────────────────────────

describe('createPoll', () => {
  it('rejects empty question', async () => {
    await expect(createPoll({ ...baseInput, question: '   ' })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects question over 200 chars', async () => {
    await expect(createPoll({ ...baseInput, question: 'a'.repeat(201) })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects fewer than 2 options', async () => {
    await expect(createPoll({ ...baseInput, options: ['only'] })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects more than 12 options', async () => {
    await expect(createPoll({ ...baseInput, options: Array.from({ length: 13 }, (_, i) => `o${i}`) })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects option over 100 chars', async () => {
    await expect(createPoll({ ...baseInput, options: ['ok', 'a'.repeat(101)] })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects when caller is not a participant', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(createPoll(baseInput)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when caller has left', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: new Date() });

    await expect(createPoll(baseInput)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects member in admins-only group', async () => {
    mockPrisma.conversationParticipant.findUnique
      .mockResolvedValueOnce({ leftAt: null })  // first check
      .mockResolvedValueOnce({ role: 'MEMBER' }); // role check
    mockPrisma.conversation.findUnique.mockResolvedValue({ adminsOnlyMessages: true, type: 'GROUP' });

    await expect(createPoll(baseInput)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws NotFoundError when conversation missing', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
    mockPrisma.conversation.findUnique.mockResolvedValue(null);

    await expect(createPoll(baseInput)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('creates poll, message, and broadcasts', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
    mockPrisma.conversation.findUnique.mockResolvedValue({ adminsOnlyMessages: false, type: 'HUMAN_MATCHED' });
    mockPrisma.message.create.mockResolvedValue({ id: 'm-1', sender: { id: 'user-1' } });
    mockPrisma.poll.create.mockResolvedValue(pollFull());
    mockPrisma.poll.findUnique.mockResolvedValue(pollFull());

    const res = await createPoll(baseInput);

    expect(mockPrisma.message.create).toHaveBeenCalled();
    expect(mockPrisma.poll.create).toHaveBeenCalled();
    expect(res.id).toBe('p-1');

    const utils = await import('../chat.utils');
    expect(utils.broadcastAndNotifyMessage).toHaveBeenCalled();
  });

  it('trims whitespace and filters empty option strings', async () => {
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });
    mockPrisma.conversation.findUnique.mockResolvedValue({ adminsOnlyMessages: false, type: 'HUMAN_MATCHED' });
    mockPrisma.message.create.mockResolvedValue({ id: 'm-1' });
    mockPrisma.poll.create.mockResolvedValue(pollFull());
    mockPrisma.poll.findUnique.mockResolvedValue(pollFull());

    await createPoll({ ...baseInput, options: ['  A  ', '', 'B', '   '] });

    const callArgs = mockPrisma.poll.create.mock.calls[0][0];
    const optTexts = callArgs.data.options.create.map((o: any) => o.text);
    expect(optTexts).toEqual(['A', 'B']);
  });
});

// ─── getPollDetails ──────────────────────────────────────────────────

describe('getPollDetails', () => {
  it('throws NotFoundError when poll missing', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue(null);
    await expect(getPollDetails('p-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when caller is not a participant of the conversation', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue(pollFull());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(getPollDetails('p-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns aggregated vote counts and votedByMe flags', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue(pollFull({
      options: [
        {
          id: 'opt-1', text: 'A', orderIdx: 0,
          votes: [
            { voterId: 'user-1', voter: { id: 'user-1', displayName: 'Me', avatarUrl: null } },
            { voterId: 'u-2', voter: { id: 'u-2', displayName: 'Bob', avatarUrl: null } },
          ],
        },
        { id: 'opt-2', text: 'B', orderIdx: 1, votes: [] },
      ],
    }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });

    const res = await getPollDetails('p-1', 'user-1');

    expect(res.totalVotes).toBe(2);
    expect(res.options[0]).toMatchObject({ voteCount: 2, votedByMe: true });
    expect(res.options[1]).toMatchObject({ voteCount: 0, votedByMe: false });
  });
});

// ─── vote ────────────────────────────────────────────────────────────

describe('vote', () => {
  it('rejects empty optionIds', async () => {
    await expect(vote('p-1', 'user-1', [])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws NotFoundError when poll missing', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue(null);
    await expect(vote('p-x', 'user-1', ['opt-1'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects votes on closed poll', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue({
      id: 'p-1', conversationId: 'c-1', closedAt: new Date(),
      allowMultiple: false, options: [{ id: 'opt-1' }],
    });
    await expect(vote('p-1', 'user-1', ['opt-1'])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects invalid option id', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue({
      id: 'p-1', conversationId: 'c-1', closedAt: null,
      allowMultiple: false, options: [{ id: 'opt-1' }, { id: 'opt-2' }],
    });

    await expect(vote('p-1', 'user-1', ['bogus'])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects multiple options when allowMultiple=false', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue({
      id: 'p-1', conversationId: 'c-1', closedAt: null,
      allowMultiple: false, options: [{ id: 'opt-1' }, { id: 'opt-2' }],
    });

    await expect(vote('p-1', 'user-1', ['opt-1', 'opt-2'])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects non-participants', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue({
      id: 'p-1', conversationId: 'c-1', closedAt: null,
      allowMultiple: false, options: [{ id: 'opt-1' }],
    });
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue(null);

    await expect(vote('p-1', 'user-1', ['opt-1'])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('replaces existing vote set with new selection', async () => {
    mockPrisma.poll.findUnique
      .mockResolvedValueOnce({  // for vote()
        id: 'p-1', conversationId: 'c-1', closedAt: null,
        allowMultiple: true, options: [{ id: 'opt-1' }, { id: 'opt-2' }, { id: 'opt-3' }],
      })
      .mockResolvedValueOnce(pollFull());  // for getPollDetails inside vote()
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });

    await vote('p-1', 'user-1', ['opt-1', 'opt-2']);

    expect(mockPrisma.pollVote.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        pollId: 'p-1',
        voterId: 'user-1',
        optionId: { notIn: ['opt-1', 'opt-2'] },
      }),
    }));
    expect(mockPrisma.pollVote.upsert).toHaveBeenCalledTimes(2);
  });

  it('emits poll-updated socket event', async () => {
    mockPrisma.poll.findUnique
      .mockResolvedValueOnce({
        id: 'p-1', conversationId: 'c-1', closedAt: null,
        allowMultiple: false, options: [{ id: 'opt-1' }, { id: 'opt-2' }],
      })
      .mockResolvedValueOnce(pollFull());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });

    await vote('p-1', 'user-1', ['opt-1']);

    expect(mockIO.getIO).toHaveBeenCalled();
  });
});

// ─── closePoll ───────────────────────────────────────────────────────

describe('closePoll', () => {
  it('throws NotFoundError when poll missing', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue(null);
    await expect(closePoll('p-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when caller is not the creator', async () => {
    mockPrisma.poll.findUnique.mockResolvedValue({ creatorId: 'someone-else', conversationId: 'c-1', closedAt: null });

    await expect(closePoll('p-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('idempotent when poll already closed', async () => {
    mockPrisma.poll.findUnique
      .mockResolvedValueOnce({ creatorId: 'user-1', conversationId: 'c-1', closedAt: new Date() })
      .mockResolvedValueOnce(pollFull({ closedAt: new Date() }));
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });

    await closePoll('p-1', 'user-1');

    expect(mockPrisma.poll.update).not.toHaveBeenCalled();
  });

  it('sets closedAt when called by creator on open poll', async () => {
    mockPrisma.poll.findUnique
      .mockResolvedValueOnce({ creatorId: 'user-1', conversationId: 'c-1', closedAt: null })
      .mockResolvedValueOnce(pollFull());
    mockPrisma.conversationParticipant.findUnique.mockResolvedValue({ leftAt: null });

    await closePoll('p-1', 'user-1');

    expect(mockPrisma.poll.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { closedAt: expect.any(Date) },
    }));
  });
});
