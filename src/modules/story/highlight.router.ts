import { Router, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import {
  listHighlights,
  createHighlight,
  addSlidesToHighlight,
  updateHighlight,
  deleteHighlight,
  removeHighlightSlide,
} from './highlight.service';

const router = Router();

// ─── GET /api/highlights/user/:userId ────────────────────────
router.get('/user/:userId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const highlights = await listHighlights(req.params.userId as string);
    res.json({ highlights });
  } catch (error: any) {
    logger.error({ error }, 'Error listing highlights');
    res.status(500).json({ error: 'Failed to list highlights' });
  }
});

// ─── POST /api/highlights ───────────────────────────────────
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { title, coverUrl, slideIds } = req.body ?? {};
    const created = await createHighlight(req.user!.userId, {
      title,
      coverUrl,
      slideIds: Array.isArray(slideIds) ? slideIds : undefined,
    });
    res.status(201).json({ highlight: created });
  } catch (error: any) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ error }, 'Error creating highlight');
    res.status(500).json({ error: 'Failed to create highlight' });
  }
});

// ─── POST /api/highlights/:id/slides ────────────────────────
router.post('/:id/slides', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const slideIds = (req.body?.slideIds ?? []) as string[];
    if (!Array.isArray(slideIds) || slideIds.length === 0) {
      return res.status(400).json({ error: 'slideIds required' });
    }
    const result = await addSlidesToHighlight(
      req.user!.userId,
      req.params.id as string,
      slideIds,
    );
    res.json(result);
  } catch (error: any) {
    if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
    if (error?.statusCode === 403) return res.status(403).json({ error: error.message });
    if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ error }, 'Error adding slides to highlight');
    res.status(500).json({ error: 'Failed to add slides' });
  }
});

// ─── PATCH /api/highlights/:id ──────────────────────────────
router.patch('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { title, coverUrl } = req.body ?? {};
    await updateHighlight(req.user!.userId, req.params.id as string, {
      title,
      coverUrl,
    });
    res.json({ success: true });
  } catch (error: any) {
    if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
    if (error?.statusCode === 403) return res.status(403).json({ error: error.message });
    if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ error }, 'Error updating highlight');
    res.status(500).json({ error: 'Failed to update highlight' });
  }
});

// ─── DELETE /api/highlights/:id ─────────────────────────────
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await deleteHighlight(req.user!.userId, req.params.id as string);
    res.json({ success: true });
  } catch (error: any) {
    if (error?.statusCode === 403) return res.status(403).json({ error: error.message });
    if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ error }, 'Error deleting highlight');
    res.status(500).json({ error: 'Failed to delete highlight' });
  }
});

// ─── DELETE /api/highlights/:id/slides/:slideId ─────────────
router.delete('/:id/slides/:slideId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await removeHighlightSlide(
      req.user!.userId,
      req.params.id as string,
      req.params.slideId as string,
    );
    res.json({ success: true });
  } catch (error: any) {
    if (error?.statusCode === 403) return res.status(403).json({ error: error.message });
    if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
    logger.error({ error }, 'Error removing highlight slide');
    res.status(500).json({ error: 'Failed to remove slide' });
  }
});

export { router as highlightRouter };
