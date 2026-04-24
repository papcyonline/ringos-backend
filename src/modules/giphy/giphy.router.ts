import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import * as giphyService from './giphy.service';

const router = Router();

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(5000, Math.floor(n));
}

// GET /trending — list trending GIFs
router.get('/trending', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const data = await giphyService.getTrending(limit, offset);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /search?q=... — search GIFs
router.get('/search', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = ((req.query.q as string) ?? '').trim();
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const data = await giphyService.searchGifs(q, limit, offset);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export { router as giphyRouter };
