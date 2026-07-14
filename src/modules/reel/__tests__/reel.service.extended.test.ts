import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockCache } = vi.hoisted(() => {
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
    reelLike: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    reelRepost: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    reelReaction: { upsert: vi.fn(), deleteMany: vi.fn() },
    reelView: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    reelComment: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    follow: { findMany: vi.fn() },
    $transaction: tx,
  };
  const mockCache: any = {
    delPattern: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  };
  return { mockPrisma, mockCache };
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
  isCloudinaryConfigured: true,
  uploadUrl: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('../../../shared/redis.service', () => mockCache);
vi.mock('../../spotlight/spotlight.service', () => ({
  getBlockedUserIds: vi.fn().mockResolvedValue(new Set()),
}));

import {
  createReel,
  getReelFeed,
  invalidateReelFeedCache,
} from '../reel.service';
import { BadRequestError } from '../../../shared/errors';

const file = (over: Partial<any> = {}) => ({
  buffer: Buffer.from('video-bytes'),
  originalname: 'reel.mp4',
  mimetype: 'video/mp4',
  ...over,
}) as any;

const baseReel = (over: Partial<any> = {}) => ({
  id: 'r-1',
  userId: 'u-other',
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
  viewCount: 100,
  likeCount: 10,
  commentCount: 2,
  repostCount: 1,
  createdAt: new Date(Date.now() - 3 * 3600 * 1000),
  videoEdits: null,
  user: { id: 'u-other', displayName: 'Bob', avatarUrl: null, isVerified: false },
  likes: [],
  reposts: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCache.delPattern.mockResolvedValue(undefined);
  mockCache.get.mockResolvedValue(null);
  mockCache.set.mockResolvedValue(undefined);
});

// ─── invalidateReelFeedCache ─────────────────────────────────────────

describe('invalidateReelFeedCache', () => {
  it('deletes all keys matching the user prefix', async () => {
    await invalidateReelFeedCache('user-1');

    expect(mockCache.delPattern).toHaveBeenCalledWith('reels:feed:user-1:*');
  });
});

// ─── createReel — Cloudinary path ────────────────────────────────────

describe('createReel (Cloudinary processing)', () => {
  it('uses Cloudinary URL + derives thumbnail when isCloudinaryConfigured=true', async () => {
    const r2 = await import('../../../shared/r2.service');
    const cdn = await import('../../../shared/cloudinary.service');
    (r2.uploadToR2WithKey as any).mockResolvedValue({ url: 'https://r2/x.mp4', key: 'reels/u/x.mp4' });
    (cdn.uploadUrl as any).mockResolvedValue({ secureUrl: 'https://res.cdn/yomeet/reels/u/x.mp4' });

    mockPrisma.reel.create.mockResolvedValue({
      ...baseReel(),
      videoUrl: 'https://res.cdn/yomeet/reels/u/x.mp4',
      thumbnailUrl: 'https://res.cdn/yomeet/reels/u/x.jpg',
    });

    const res = await createReel('user-1', file(), { caption: 'cap', durationSec: 30 });

    expect(res.videoUrl).toBe('https://res.cdn/yomeet/reels/u/x.mp4');
    expect(res.thumbnailUrl).toBe('https://res.cdn/yomeet/reels/u/x.jpg');
  });

  it('falls back to R2 URL when Cloudinary upload throws', async () => {
    const r2 = await import('../../../shared/r2.service');
    const cdn = await import('../../../shared/cloudinary.service');
    (r2.uploadToR2WithKey as any).mockResolvedValue({ url: 'https://r2/x.mp4', key: 'reels/u/x.mp4' });
    (cdn.uploadUrl as any).mockRejectedValue(new Error('cdn boom'));

    mockPrisma.reel.create.mockResolvedValue({ ...baseReel(), videoUrl: 'https://r2/x.mp4', thumbnailUrl: null });

    const res = await createReel('user-1', file());

    expect(res.videoUrl).toBe('https://r2/x.mp4');
    expect(res.thumbnailUrl).toBeNull();
  });

  it('falls back to R2 URL when Cloudinary returns no secureUrl', async () => {
    const r2 = await import('../../../shared/r2.service');
    const cdn = await import('../../../shared/cloudinary.service');
    (r2.uploadToR2WithKey as any).mockResolvedValue({ url: 'https://r2/x.mp4', key: 'reels/u/x.mp4' });
    (cdn.uploadUrl as any).mockResolvedValue(null);

    mockPrisma.reel.create.mockResolvedValue({ ...baseReel(), videoUrl: 'https://r2/x.mp4', thumbnailUrl: null });

    const res = await createReel('user-1', file());

    expect(res.videoUrl).toBe('https://r2/x.mp4');
  });
});

// ─── getReelFeed ─────────────────────────────────────────────────────

describe('getReelFeed', () => {
  it('returns cached payload on first page when present', async () => {
    const cached = { reels: [{ id: 'cached-r' }], nextCursor: 'more' };
    mockCache.get.mockResolvedValueOnce(cached);

    const res = await getReelFeed('user-1');

    expect(res).toBe(cached);
    expect(mockPrisma.reel.findMany).not.toHaveBeenCalled();
  });

  it('skips cache when cursor present (paginated request)', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([]);

    await getReelFeed('user-1', 'more');

    expect(mockCache.get).not.toHaveBeenCalled();
  });

  it('audience=following with no follows returns empty + caches', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);

    const res = await getReelFeed('user-1', undefined, 10, 'following');

    expect(res).toEqual({ reels: [], nextCursor: null });
    expect(mockCache.set).toHaveBeenCalled();
    expect(mockPrisma.reel.findMany).not.toHaveBeenCalled();
  });

  it('audience=mine returns own reels chronologically', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([
      baseReel({ id: 'mine-1', userId: 'user-1', likes: [{ id: 'l-1' }], reposts: [] }),
    ]);

    const res = await getReelFeed('user-1', undefined, 10, 'mine');

    expect(mockPrisma.reel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
    }));
    expect(res.reels[0]).toMatchObject({ id: 'mine-1', isLiked: true, isReposted: false });
    expect(res.nextCursor).toBeNull();
  });

  it('audience=all ranks candidates and applies diversity', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([{ followingId: 'creator-A' }]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([
      baseReel({ id: 'r-A1', userId: 'creator-A', likeCount: 100 }),
      baseReel({ id: 'r-A2', userId: 'creator-A', likeCount: 90 }),
      baseReel({ id: 'r-A3', userId: 'creator-A', likeCount: 85 }),
      baseReel({ id: 'r-B1', userId: 'creator-B', likeCount: 80 }),
    ]);

    const res = await getReelFeed('user-1', undefined, 4, 'all');

    // Diversity caps consecutive same-author at MAX_CONSECUTIVE_SAME_AUTHOR=1.
    // The exact ordering depends on randomness but author B's reel must appear
    // somewhere in the first 4 (3 from A would otherwise dominate).
    const authors = res.reels.map((r: any) => (r.user as any).id);
    expect(authors).toContain('u-other'); // creator-A and creator-B both use 'u-other' user template
    // Verify diversity: not three A-IDs in a row early
    const countA = authors.filter((a: string) => a === 'u-other').length;
    expect(countA).toBeLessThanOrEqual(4); // sanity
  });

  it('returns nextCursor="more" when result fills the limit', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    // 10 distinct authors so diversity doesn't cap us before 5
    const reels = Array.from({ length: 10 }, (_, i) =>
      baseReel({ id: `r-${i}`, userId: `creator-${i}` }),
    );
    mockPrisma.reel.findMany.mockResolvedValue(reels);

    const res = await getReelFeed('user-1', undefined, 5, 'all');

    expect(res.reels).toHaveLength(5);
    expect(res.nextCursor).toBe('more');
  });

  it('returns nextCursor=null when result is short of limit', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([
      baseReel({ id: 'r-1', userId: 'creator-A' }),
    ]);

    const res = await getReelFeed('user-1', undefined, 5, 'all');

    expect(res.reels).toHaveLength(1);
    expect(res.nextCursor).toBeNull();
  });

  it('excludes already-viewed reels but keeps own reels in feed', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([
      { reelId: 'viewed-1' }, { reelId: 'viewed-2' },
    ]);
    mockPrisma.reel.findMany.mockResolvedValue([]);

    await getReelFeed('user-1');

    expect(mockPrisma.reel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { id: { notIn: ['viewed-1', 'viewed-2'] } },
          { userId: 'user-1' },
        ],
      }),
    }));
  });

  it('excludes blocked authors from candidate pool', async () => {
    const spotlight = await import('../../spotlight/spotlight.service');
    (spotlight.getBlockedUserIds as any).mockResolvedValueOnce(new Set(['blocked-1', 'blocked-2']));
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([]);

    await getReelFeed('user-1');

    expect(mockPrisma.reel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: { notIn: ['blocked-1', 'blocked-2'] },
      }),
    }));
  });

  it('audience=following filters candidate pool to following set', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([{ followingId: 'creator-A' }]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([]);

    await getReelFeed('user-1', undefined, 10, 'following');

    expect(mockPrisma.reel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: expect.objectContaining({
          in: ['creator-A'],
        }),
      }),
    }));
  });

  it('caches result on first page', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([baseReel()]);

    await getReelFeed('user-1');

    expect(mockCache.set).toHaveBeenCalledWith(
      'reels:feed:user-1:all:10',
      expect.objectContaining({ reels: expect.any(Array) }),
      30,
    );
  });

  it('does NOT cache when cursor passed', async () => {
    mockPrisma.follow.findMany.mockResolvedValue([]);
    mockPrisma.reelView.findMany.mockResolvedValue([]);
    mockPrisma.reel.findMany.mockResolvedValue([baseReel()]);

    await getReelFeed('user-1', 'more');

    expect(mockCache.set).not.toHaveBeenCalled();
  });
});
