import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import * as musicService from './music.service';

const router = Router();

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

router.get('/trending', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await musicService.getTrending(clampLimit(req.query.limit));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get('/search', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = ((req.query.q as string) ?? '').trim();
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    const data = await musicService.searchMusic(q, clampLimit(req.query.limit));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export { router as musicRouter };
