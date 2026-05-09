import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma: any = {
    storyHighlight: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    storyHighlightSlide: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    storySlide: {
      findMany: vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  listHighlights,
  createHighlight,
  addSlidesToHighlight,
  updateHighlight,
  deleteHighlight,
  removeHighlightSlide,
} from '../highlight.service';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../shared/errors';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── listHighlights ──────────────────────────────────────────────────

describe('listHighlights', () => {
  it('returns highlights with derived coverUrl fallbacks', async () => {
    mockPrisma.storyHighlight.findMany.mockResolvedValue([
      {
        id: 'h-1', userId: 'u-1', title: 'Trip', coverUrl: 'cover.jpg',
        createdAt: new Date(), updatedAt: new Date(),
        slides: [{ thumbnailUrl: 't.jpg', mediaUrl: 'm.jpg' }],
      },
      {
        id: 'h-2', userId: 'u-1', title: 'Food', coverUrl: null,
        createdAt: new Date(), updatedAt: new Date(),
        slides: [{ thumbnailUrl: 'food-thumb.jpg', mediaUrl: 'food.jpg' }],
      },
      {
        id: 'h-3', userId: 'u-1', title: 'Empty', coverUrl: null,
        createdAt: new Date(), updatedAt: new Date(),
        slides: [],
      },
    ]);

    const res = await listHighlights('u-1');

    expect(res[0].coverUrl).toBe('cover.jpg');           // explicit cover
    expect(res[1].coverUrl).toBe('food-thumb.jpg');       // first slide thumbnail
    expect(res[2].coverUrl).toBeNull();                   // no slides → null
    expect(res[0].slideCount).toBe(1);
  });
});

// ─── createHighlight ─────────────────────────────────────────────────

describe('createHighlight', () => {
  it('rejects empty title', async () => {
    await expect(createHighlight('u-1', { title: '   ' })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects title over 40 chars', async () => {
    await expect(createHighlight('u-1', { title: 'a'.repeat(41) })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects when at the 50-highlight cap', async () => {
    mockPrisma.storyHighlight.count.mockResolvedValue(50);

    await expect(createHighlight('u-1', { title: 'New' })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('creates with no seed slides when slideIds empty', async () => {
    mockPrisma.storyHighlight.count.mockResolvedValue(0);
    mockPrisma.storyHighlight.create.mockResolvedValue({ id: 'h-1', slides: [] });

    await createHighlight('u-1', { title: 'New' });

    const args = (mockPrisma.storyHighlight.create.mock.calls[0][0] as any);
    expect(args.data.slides.create).toEqual([]);
  });

  it('seeds with caller-owned slides only, preserving order', async () => {
    mockPrisma.storyHighlight.count.mockResolvedValue(0);
    mockPrisma.storySlide.findMany.mockResolvedValue([
      { id: 's-2', type: 'IMAGE', mediaUrl: 'm2.jpg', thumbnailUrl: null, caption: null, duration: null },
      { id: 's-1', type: 'VIDEO', mediaUrl: 'v1.mp4', thumbnailUrl: 't.jpg', caption: 'cap', duration: 5 },
    ]);
    mockPrisma.storyHighlight.create.mockResolvedValue({ id: 'h-1', slides: [] });

    await createHighlight('u-1', { title: 'Best', slideIds: ['s-1', 's-2'] });

    const created = (mockPrisma.storyHighlight.create.mock.calls[0][0] as any).data.slides.create;
    expect(created[0].mediaUrl).toBe('v1.mp4');
    expect(created[1].mediaUrl).toBe('m2.jpg');
    expect(created[0].position).toBe(0);
    expect(created[1].position).toBe(1);
  });
});

// ─── addSlidesToHighlight ────────────────────────────────────────────

describe('addSlidesToHighlight', () => {
  it('throws NotFoundError when highlight missing', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue(null);
    await expect(addSlidesToHighlight('u-1', 'h-x', ['s-1'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects non-owner', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({
      userId: 'someone-else', _count: { slides: 0 },
    });

    await expect(addSlidesToHighlight('u-1', 'h-1', ['s-1'])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects when adding would exceed 100 slides', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({
      userId: 'u-1', _count: { slides: 99 },
    });

    await expect(addSlidesToHighlight('u-1', 'h-1', ['s-1', 's-2'])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns added=0 when no owned slides match', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({
      userId: 'u-1', _count: { slides: 0 },
    });
    mockPrisma.storySlide.findMany.mockResolvedValue([]);

    const res = await addSlidesToHighlight('u-1', 'h-1', ['s-foreign']);

    expect(res).toEqual({ added: 0 });
    expect(mockPrisma.storyHighlightSlide.createMany).not.toHaveBeenCalled();
  });

  it('appends with continuing positions and bumps updatedAt', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({
      userId: 'u-1', _count: { slides: 5 },
    });
    mockPrisma.storySlide.findMany.mockResolvedValue([
      { id: 's-6', type: 'IMAGE', mediaUrl: 'm6.jpg', thumbnailUrl: null, caption: null, duration: null },
      { id: 's-7', type: 'IMAGE', mediaUrl: 'm7.jpg', thumbnailUrl: null, caption: null, duration: null },
    ]);

    const res = await addSlidesToHighlight('u-1', 'h-1', ['s-6', 's-7']);

    expect(res).toEqual({ added: 2 });
    const created = (mockPrisma.storyHighlightSlide.createMany.mock.calls[0][0] as any).data;
    expect(created[0].position).toBe(5);
    expect(created[1].position).toBe(6);
    expect(mockPrisma.storyHighlight.update).toHaveBeenCalled();
  });
});

// ─── updateHighlight ─────────────────────────────────────────────────

describe('updateHighlight', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue(null);
    await expect(updateHighlight('u-1', 'h-x', { title: 'New' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects non-owner', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await expect(updateHighlight('u-1', 'h-1', { title: 'New' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('updates title and coverUrl', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'u-1' });

    await updateHighlight('u-1', 'h-1', { title: 'New', coverUrl: 'cover.jpg' });

    expect(mockPrisma.storyHighlight.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { title: 'New', coverUrl: 'cover.jpg' },
    }));
  });

  it('clears coverUrl when set to null', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'u-1' });

    await updateHighlight('u-1', 'h-1', { coverUrl: null });

    expect(mockPrisma.storyHighlight.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { coverUrl: null },
    }));
  });

  it('no-op when no fields provided', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'u-1' });

    await updateHighlight('u-1', 'h-1', {});

    expect(mockPrisma.storyHighlight.update).not.toHaveBeenCalled();
  });

  it('rejects empty title in patch', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'u-1' });
    await expect(updateHighlight('u-1', 'h-1', { title: '   ' })).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ─── deleteHighlight ─────────────────────────────────────────────────

describe('deleteHighlight', () => {
  it('throws NotFoundError when missing', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue(null);
    await expect(deleteHighlight('u-1', 'h-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects non-owner', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await expect(deleteHighlight('u-1', 'h-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('deletes when owner', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'u-1' });

    await deleteHighlight('u-1', 'h-1');

    expect(mockPrisma.storyHighlight.delete).toHaveBeenCalledWith({ where: { id: 'h-1' } });
  });
});

// ─── removeHighlightSlide ────────────────────────────────────────────

describe('removeHighlightSlide', () => {
  it('throws NotFoundError when highlight missing', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue(null);
    await expect(removeHighlightSlide('u-1', 'h-x', 's-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects non-owner', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await expect(removeHighlightSlide('u-1', 'h-1', 's-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('deletes the slide row when owner', async () => {
    mockPrisma.storyHighlight.findUnique.mockResolvedValue({ userId: 'u-1' });

    await removeHighlightSlide('u-1', 'h-1', 's-1');

    expect(mockPrisma.storyHighlightSlide.deleteMany).toHaveBeenCalledWith({
      where: { id: 's-1', highlightId: 'h-1' },
    });
  });
});
