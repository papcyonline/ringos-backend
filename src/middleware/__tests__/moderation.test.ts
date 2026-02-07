import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────
vi.mock('../../modules/safety/moderation.service', () => ({
  moderateContent: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { moderateMessage } from '../moderation';
import { moderateContent } from '../../modules/safety/moderation.service';
import { BadRequestError } from '../../shared/errors';

// ── Helpers ─────────────────────────────────────────────────────────

function mockReqResNext(body: Record<string, any> = {}, user?: any) {
  const req: any = {
    body: { ...body },
    user,
  };
  const res: any = {};
  const next = vi.fn();
  return { req, res, next };
}

describe('moderateMessage middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Skips for non-string / empty field ────────────────────────────

  it('should call next() and skip moderation when field is missing', async () => {
    const { req, res, next } = mockReqResNext({});
    await moderateMessage('content')(req, res, next);

    expect(moderateContent).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('should call next() and skip moderation when field is not a string', async () => {
    const { req, res, next } = mockReqResNext({ content: 123 });
    await moderateMessage('content')(req, res, next);

    expect(moderateContent).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('should call next() and skip moderation when field is empty string', async () => {
    const { req, res, next } = mockReqResNext({ content: '' });
    await moderateMessage('content')(req, res, next);

    expect(moderateContent).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  // ── Clean content ─────────────────────────────────────────────────

  it('should call next() and set cleaned text when content is clean', async () => {
    (moderateContent as any).mockResolvedValue({
      flagged: false,
      cleaned: 'hello world',
    });

    const { req, res, next } = mockReqResNext({ content: 'hello world' });
    await moderateMessage('content')(req, res, next);

    expect(moderateContent).toHaveBeenCalledWith('hello world');
    expect(req.body.content).toBe('hello world');
    expect(next).toHaveBeenCalledWith();
  });

  // ── Flagged content ───────────────────────────────────────────────

  it('should call next with BadRequestError when content is flagged', async () => {
    (moderateContent as any).mockResolvedValue({
      flagged: true,
      reason: 'hateful content',
      cleaned: 'cleaned text',
    });

    const { req, res, next } = mockReqResNext({ content: 'bad stuff' });
    await moderateMessage('content')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.code).toBe('CONTENT_FLAGGED');
  });

  // ── Service failure (fail-open) ───────────────────────────────────

  it('should call next() without error when moderation service throws (fail-open)', async () => {
    (moderateContent as any).mockRejectedValue(new Error('OpenAI API down'));

    const { req, res, next } = mockReqResNext(
      { content: 'hello' },
      { userId: 'user-1' },
    );
    await moderateMessage('content')(req, res, next);

    expect(next).toHaveBeenCalledWith();
    // next should be called without an error argument
    expect(next.mock.calls[0].length).toBe(0);
  });

  // ── Custom field name ─────────────────────────────────────────────

  it('should use the default "content" field when no field is specified', async () => {
    (moderateContent as any).mockResolvedValue({
      flagged: false,
      cleaned: 'text',
    });

    const { req, res, next } = mockReqResNext({ content: 'text' });
    await moderateMessage()(req, res, next);

    expect(moderateContent).toHaveBeenCalledWith('text');
  });

  it('should moderate the specified custom field', async () => {
    (moderateContent as any).mockResolvedValue({
      flagged: false,
      cleaned: 'bio text cleaned',
    });

    const { req, res, next } = mockReqResNext({ bio: 'bio text' });
    await moderateMessage('bio')(req, res, next);

    expect(moderateContent).toHaveBeenCalledWith('bio text');
    expect(req.body.bio).toBe('bio text cleaned');
  });
});
