import { prisma } from '../../config/database';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors';

/**
 * Story Highlights — permanent collections of story slides shown on a
 * user's profile (Instagram-style). Slides are *copied* from StorySlide at
 * add-time so the highlight outlives the original story's expiry.
 *
 * SRP: this file owns the read/write surface for highlights only. It does
 * not push notifications or mutate Story rows.
 */

const MAX_TITLE_LEN = 40;
const MAX_HIGHLIGHTS_PER_USER = 50;
const MAX_SLIDES_PER_HIGHLIGHT = 100;

function normalizeTitle(raw?: string | null): string {
  const t = (raw ?? '').trim();
  if (!t) throw new BadRequestError('Highlight title is required');
  if (t.length > MAX_TITLE_LEN) {
    throw new BadRequestError(`Title must be ${MAX_TITLE_LEN} chars or less`);
  }
  return t;
}

/**
 * Public read: list highlights for any user (used on their profile).
 */
export async function listHighlights(userId: string) {
  const rows = await prisma.storyHighlight.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      slides: {
        orderBy: { position: 'asc' },
      },
    },
  });
  return rows.map((h) => ({
    id: h.id,
    userId: h.userId,
    title: h.title,
    coverUrl: h.coverUrl ?? h.slides[0]?.thumbnailUrl ?? h.slides[0]?.mediaUrl ?? null,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
    slideCount: h.slides.length,
    slides: h.slides,
  }));
}

/**
 * Create a new highlight. Optionally seed it with one or more existing
 * story slides (slideIds must belong to the requester).
 */
export async function createHighlight(
  userId: string,
  input: { title: string; coverUrl?: string; slideIds?: string[] },
) {
  const title = normalizeTitle(input.title);

  const count = await prisma.storyHighlight.count({ where: { userId } });
  if (count >= MAX_HIGHLIGHTS_PER_USER) {
    throw new BadRequestError(
      `You can have at most ${MAX_HIGHLIGHTS_PER_USER} highlights`,
    );
  }

  const seedSlides = await loadOwnedSlides(userId, input.slideIds ?? []);

  const created = await prisma.storyHighlight.create({
    data: {
      userId,
      title,
      coverUrl: input.coverUrl ?? null,
      slides: {
        create: seedSlides.map((s, i) => ({
          type: s.type,
          mediaUrl: s.mediaUrl,
          thumbnailUrl: s.thumbnailUrl,
          caption: s.caption,
          duration: s.duration,
          position: i,
        })),
      },
    },
    include: { slides: { orderBy: { position: 'asc' } } },
  });
  return created;
}

/**
 * Append story slides to an existing highlight.
 */
export async function addSlidesToHighlight(
  userId: string,
  highlightId: string,
  slideIds: string[],
) {
  const h = await prisma.storyHighlight.findUnique({
    where: { id: highlightId },
    select: { userId: true, _count: { select: { slides: true } } },
  });
  if (!h) throw new NotFoundError('Highlight not found');
  if (h.userId !== userId) throw new ForbiddenError('Not your highlight');
  if (h._count.slides + slideIds.length > MAX_SLIDES_PER_HIGHLIGHT) {
    throw new BadRequestError(
      `A highlight can have at most ${MAX_SLIDES_PER_HIGHLIGHT} slides`,
    );
  }

  const newSlides = await loadOwnedSlides(userId, slideIds);
  if (newSlides.length === 0) return { added: 0 };

  await prisma.storyHighlightSlide.createMany({
    data: newSlides.map((s, i) => ({
      highlightId,
      type: s.type,
      mediaUrl: s.mediaUrl,
      thumbnailUrl: s.thumbnailUrl,
      caption: s.caption,
      duration: s.duration,
      position: h._count.slides + i,
    })),
  });
  // Bump updatedAt so the highlight float to the top of the user's list.
  await prisma.storyHighlight.update({
    where: { id: highlightId },
    data: { updatedAt: new Date() },
  });
  return { added: newSlides.length };
}

/**
 * Rename or update cover.
 */
export async function updateHighlight(
  userId: string,
  highlightId: string,
  patch: { title?: string; coverUrl?: string | null },
) {
  const h = await prisma.storyHighlight.findUnique({
    where: { id: highlightId },
    select: { userId: true },
  });
  if (!h) throw new NotFoundError('Highlight not found');
  if (h.userId !== userId) throw new ForbiddenError('Not your highlight');

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = normalizeTitle(patch.title);
  if (patch.coverUrl !== undefined) data.coverUrl = patch.coverUrl;
  if (Object.keys(data).length === 0) return;

  await prisma.storyHighlight.update({ where: { id: highlightId }, data });
}

/**
 * Delete a highlight (and its slides cascade).
 */
export async function deleteHighlight(userId: string, highlightId: string) {
  const h = await prisma.storyHighlight.findUnique({
    where: { id: highlightId },
    select: { userId: true },
  });
  if (!h) throw new NotFoundError('Highlight not found');
  if (h.userId !== userId) throw new ForbiddenError('Not your highlight');
  await prisma.storyHighlight.delete({ where: { id: highlightId } });
}

/**
 * Remove a single slide from a highlight (does not affect the original Story).
 */
export async function removeHighlightSlide(
  userId: string,
  highlightId: string,
  slideId: string,
) {
  const h = await prisma.storyHighlight.findUnique({
    where: { id: highlightId },
    select: { userId: true },
  });
  if (!h) throw new NotFoundError('Highlight not found');
  if (h.userId !== userId) throw new ForbiddenError('Not your highlight');

  await prisma.storyHighlightSlide.deleteMany({
    where: { id: slideId, highlightId },
  });
}

// ─── Internal ──────────────────────────────────────────────

async function loadOwnedSlides(userId: string, slideIds: string[]) {
  if (slideIds.length === 0) return [];
  const slides = await prisma.storySlide.findMany({
    where: {
      id: { in: slideIds },
      story: { userId },
    },
    select: {
      id: true,
      type: true,
      mediaUrl: true,
      thumbnailUrl: true,
      caption: true,
      duration: true,
    },
  });
  // Preserve caller's order.
  const byId = new Map(slides.map((s) => [s.id, s]));
  return slideIds.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
}
