import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const tx = vi.fn(async (ops: any) => {
    if (typeof ops === 'function') return ops(mockPrisma);
    return Promise.all(ops);
  });
  const mockPrisma: any = {
    reel: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    reelLike: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    reelRepost: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    reelReaction: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    reelView: {
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    reelComment: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: tx,
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../shared/r2.service', () => ({
  isR2Configured: true,
  uploadToR2WithKey: vi.fn(),
  deleteFromR2: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shared/moderation.service', () => ({
  moderateVideoBuffer: vi.fn().mockResolvedValue({ safe: true }),
}));
vi.mock('../../../shared/cloudinary.service', () => ({
  isCloudinaryConfigured: false,
  uploadUrl: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('../../../shared/redis.service', () => ({
  delPattern: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: vi.fn().mockResolvedValue(new Set()),
}));

import {
  createReel,
  reactToReel,
  clearReelReaction,
  likeReel,
  unlikeReel,
  repostReel,
  unrepostReel,
  markReelViewed,
  countReelsCreatedSince,
  addReelComment,
  getReelComments,
  deleteReelComment,
  deleteReel,
} from '../reel.service';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../shared/errors';

const file = (over: Partial<any> = {}) => ({
  buffer: Buffer.from('video-bytes'),
  originalname: 'reel.mp4',
  mimetype: 'video/mp4',
  ...over,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── createReel ──────────────────────────────────────────────────────

describe('createReel', () => {
  it('rejects when no file', async () => {
    await expect(createReel('user-1', null as any)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects when duration exceeds 62s tolerance', async () => {
    await expect(createReel('user-1', file(), { durationSec: 90 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects with MODERATION_REJECTED when video fails moderation', async () => {
    const r2 = await import('../../../shared/r2.service');
    (r2.uploadToR2WithKey as any).mockResolvedValueOnce({ url: 'https://r2/x.mp4', key: 'reels/u/x.mp4' });
    const mod = await import('../../../shared/moderation.service');
    (mod.moderateVideoBuffer as any).mockResolvedValueOnce({ safe: false, reason: 'nudity' });

    await expect(createReel('user-1', file())).rejects.toMatchObject({
      message: 'nudity',
      code: 'MODERATION_REJECTED',
    });
    expect(r2.deleteFromR2).toHaveBeenCalledWith('reels/u/x.mp4');
  });

  it('persists reel and returns formatted DTO when moderation passes', async () => {
    const r2 = await import('../../../shared/r2.service');
    (r2.uploadToR2WithKey as any).mockResolvedValueOnce({ url: 'https://r2/x.mp4', key: 'reels/u/x.mp4' });
    mockPrisma.reel.create.mockResolvedValue({
      id: 'reel-1',
      videoUrl: 'https://r2/x.mp4',
      thumbnailUrl: null,
      caption: 'cap',
      musicTitle: null,
      musicPreviewUrl: null,
      musicArtist: null,
      musicArtwork: null,
      videoVolume: null,
      musicVolume: null,
      durationSec: 30,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(),
      videoEdits: null,
      user: { id: 'user-1', displayName: 'Alice', avatarUrl: null, isVerified: false },
    });

    const res = await createReel('user-1', file(), { caption: '  cap  ', durationSec: 30 });

    expect(res.id).toBe('reel-1');
    expect(res.isLiked).toBe(false);
    expect(res.isReposted).toBe(false);
    expect(mockPrisma.reel.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ caption: 'cap', durationSec: 30 }),
    }));
  });
});

// ─── reactToReel / clearReelReaction ─────────────────────────────────

describe('reactToReel', () => {
  it('rejects emoji not in allowed set', async () => {
    await expect(reactToReel('reel-1', 'user-1', '🌮')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns null when reel not found', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue(null);
    const res = await reactToReel('reel-x', 'user-1', '❤️');
    expect(res).toBeNull();
  });

  it('upserts reaction and returns emoji', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({ id: 'reel-1' });
    mockPrisma.reelReaction.upsert.mockResolvedValue({});

    const res = await reactToReel('reel-1', 'user-1', '🔥');

    expect(res).toEqual({ emoji: '🔥' });
    expect(mockPrisma.reelReaction.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { reelId_userId: { reelId: 'reel-1', userId: 'user-1' } },
    }));
  });
});

describe('clearReelReaction', () => {
  it('deletes reactions for the user on the reel', async () => {
    await clearReelReaction('reel-1', 'user-1');
    expect(mockPrisma.reelReaction.deleteMany).toHaveBeenCalledWith({
      where: { reelId: 'reel-1', userId: 'user-1' },
    });
  });
});

// ─── like / unlike ───────────────────────────────────────────────────

describe('likeReel', () => {
  it('no-op when already liked', async () => {
    mockPrisma.reelLike.findUnique.mockResolvedValue({ id: 'like-1' });

    await likeReel('reel-1', 'user-1');

    expect(mockPrisma.reelLike.create).not.toHaveBeenCalled();
    expect(mockPrisma.reel.update).not.toHaveBeenCalled();
  });

  it('creates like and increments counter', async () => {
    mockPrisma.reelLike.findUnique.mockResolvedValue(null);

    await likeReel('reel-1', 'user-1');

    expect(mockPrisma.reelLike.create).toHaveBeenCalledWith({ data: { reelId: 'reel-1', userId: 'user-1' } });
    expect(mockPrisma.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-1' },
      data: { likeCount: { increment: 1 } },
    });
  });
});

describe('unlikeReel', () => {
  it('no-op when not previously liked', async () => {
    mockPrisma.reelLike.findUnique.mockResolvedValue(null);

    await unlikeReel('reel-1', 'user-1');

    expect(mockPrisma.reelLike.delete).not.toHaveBeenCalled();
  });

  it('deletes like and decrements counter', async () => {
    mockPrisma.reelLike.findUnique.mockResolvedValue({ id: 'like-1' });

    await unlikeReel('reel-1', 'user-1');

    expect(mockPrisma.reelLike.delete).toHaveBeenCalledWith({ where: { id: 'like-1' } });
    expect(mockPrisma.reel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { likeCount: { decrement: 1 } },
    }));
  });
});

// ─── repost / unrepost ───────────────────────────────────────────────

describe('repostReel', () => {
  it('no-op when already reposted', async () => {
    mockPrisma.reelRepost.findUnique.mockResolvedValue({ id: 'rp-1' });
    await repostReel('reel-1', 'user-1');
    expect(mockPrisma.reelRepost.create).not.toHaveBeenCalled();
  });

  it('creates repost row and increments counter', async () => {
    mockPrisma.reelRepost.findUnique.mockResolvedValue(null);

    await repostReel('reel-1', 'user-1');

    expect(mockPrisma.reelRepost.create).toHaveBeenCalled();
    expect(mockPrisma.reel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { repostCount: { increment: 1 } },
    }));
  });
});

describe('unrepostReel', () => {
  it('no-op when not reposted', async () => {
    mockPrisma.reelRepost.findUnique.mockResolvedValue(null);
    await unrepostReel('reel-1', 'user-1');
    expect(mockPrisma.reelRepost.delete).not.toHaveBeenCalled();
  });

  it('deletes repost row and decrements counter', async () => {
    mockPrisma.reelRepost.findUnique.mockResolvedValue({ id: 'rp-1' });

    await unrepostReel('reel-1', 'user-1');

    expect(mockPrisma.reelRepost.delete).toHaveBeenCalledWith({ where: { id: 'rp-1' } });
    expect(mockPrisma.reel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { repostCount: { decrement: 1 } },
    }));
  });
});

// ─── markReelViewed ──────────────────────────────────────────────────

describe('markReelViewed', () => {
  it('first view: creates view row and increments viewCount', async () => {
    mockPrisma.reelView.createMany.mockResolvedValue({ count: 1 });

    await markReelViewed('reel-1', 'user-1', { watchedSec: 5, completed: false });

    expect(mockPrisma.reelView.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
    }));
    expect(mockPrisma.reel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { viewCount: { increment: 1 } },
    }));
  });

  it('repeat view (duplicate skipped): updates progress monotonically, no viewCount bump', async () => {
    mockPrisma.reelView.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.reelView.findUnique.mockResolvedValue({ watchedSec: 3, completed: false });
    mockPrisma.reelView.update.mockResolvedValue({});

    await markReelViewed('reel-1', 'user-1', { watchedSec: 7, completed: true });

    expect(mockPrisma.reel.update).not.toHaveBeenCalled();
    expect(mockPrisma.reelView.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        watchedSec: 7,
        completed: true,
      }),
    }));
  });

  it('repeat view: does not regress watchedSec', async () => {
    mockPrisma.reelView.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.reelView.findUnique.mockResolvedValue({ watchedSec: 30, completed: true });
    mockPrisma.reelView.update.mockResolvedValue({});

    await markReelViewed('reel-1', 'user-1', { watchedSec: 5, completed: false });

    expect(mockPrisma.reelView.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        watchedSec: 30,
        completed: true,
      }),
    }));
  });

  it('repeat view with no existing row: no-op (no throw)', async () => {
    mockPrisma.reelView.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.reelView.findUnique.mockResolvedValue(null);

    await expect(markReelViewed('reel-1', 'user-1')).resolves.toBeUndefined();
    expect(mockPrisma.reelView.update).not.toHaveBeenCalled();
  });
});

// ─── countReelsCreatedSince ──────────────────────────────────────────

describe('countReelsCreatedSince', () => {
  it('counts reels filtered by user + createdAt cutoff', async () => {
    mockPrisma.reel.count.mockResolvedValue(4);
    const since = new Date('2026-05-01');

    const res = await countReelsCreatedSince('user-1', since);

    expect(res).toBe(4);
    expect(mockPrisma.reel.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', createdAt: { gte: since } },
    });
  });
});

// ─── comments ────────────────────────────────────────────────────────

describe('addReelComment', () => {
  it('rejects empty content', async () => {
    await expect(addReelComment('reel-1', 'user-1', '   ')).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects content over 500 chars', async () => {
    await expect(addReelComment('reel-1', 'user-1', 'a'.repeat(501))).rejects.toBeInstanceOf(BadRequestError);
  });

  it('throws NotFoundError when reel missing', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue(null);
    await expect(addReelComment('reel-x', 'user-1', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('creates comment + increments commentCount', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({ id: 'reel-1' });
    mockPrisma.reelComment.create.mockResolvedValue({
      id: 'c-1',
      content: 'great',
      user: { id: 'user-1', displayName: 'Alice', avatarUrl: null, isVerified: false },
    });

    const res = await addReelComment('reel-1', 'user-1', '  great  ');

    expect(res.id).toBe('c-1');
    expect(mockPrisma.reelComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: 'great' }),
    }));
    expect(mockPrisma.reel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { commentCount: { increment: 1 } },
    }));
  });
});

describe('getReelComments', () => {
  it('returns comments and nextCursor when over limit', async () => {
    mockPrisma.reelComment.findMany.mockResolvedValue([
      { id: 'c1', content: 'a', createdAt: new Date(), user: { id: 'u1', displayName: 'A' } },
      { id: 'c2', content: 'b', createdAt: new Date(), user: { id: 'u2', displayName: 'B' } },
      { id: 'c3', content: 'c', createdAt: new Date(), user: { id: 'u3', displayName: 'C' } },
    ]);

    const res = await getReelComments('reel-1', undefined, 2);

    expect(res.comments).toHaveLength(2);
    expect(res.nextCursor).toBe('c2');
  });

  it('returns null nextCursor when not enough for next page', async () => {
    mockPrisma.reelComment.findMany.mockResolvedValue([
      { id: 'c1', content: 'a', createdAt: new Date(), user: { id: 'u1', displayName: 'A' } },
    ]);

    const res = await getReelComments('reel-1', undefined, 30);

    expect(res.comments).toHaveLength(1);
    expect(res.nextCursor).toBeNull();
  });
});

describe('deleteReelComment', () => {
  it('throws NotFoundError when comment missing', async () => {
    mockPrisma.reelComment.findUnique.mockResolvedValue(null);
    await expect(deleteReelComment('c-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when caller is not the author', async () => {
    mockPrisma.reelComment.findUnique.mockResolvedValue({ userId: 'someone-else', reelId: 'reel-1' });

    await expect(deleteReelComment('c1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('deletes and decrements commentCount when caller is author', async () => {
    mockPrisma.reelComment.findUnique.mockResolvedValue({ userId: 'user-1', reelId: 'reel-1' });

    await deleteReelComment('c1', 'user-1');

    expect(mockPrisma.reelComment.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    expect(mockPrisma.reel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { commentCount: { decrement: 1 } },
    }));
  });
});

// ─── deleteReel ──────────────────────────────────────────────────────

describe('deleteReel', () => {
  it('throws NotFoundError when reel missing', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue(null);
    await expect(deleteReel('r-x', 'user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when caller is not the owner', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({ userId: 'someone-else', cloudinaryId: 'k' });
    await expect(deleteReel('reel-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('deletes reel and fires R2 cleanup when key present', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({ userId: 'user-1', cloudinaryId: 'reels/u/x.mp4' });
    const r2 = await import('../../../shared/r2.service');

    await deleteReel('reel-1', 'user-1');

    expect(mockPrisma.reel.delete).toHaveBeenCalledWith({ where: { id: 'reel-1' } });
    expect(r2.deleteFromR2).toHaveBeenCalledWith('reels/u/x.mp4');
  });

  it('skips R2 cleanup when no key', async () => {
    mockPrisma.reel.findUnique.mockResolvedValue({ userId: 'user-1', cloudinaryId: null });
    const r2 = await import('../../../shared/r2.service');

    await deleteReel('reel-1', 'user-1');

    expect(mockPrisma.reel.delete).toHaveBeenCalled();
    expect(r2.deleteFromR2).not.toHaveBeenCalled();
  });
});
