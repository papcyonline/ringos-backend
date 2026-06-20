import { Router, Request, Response, NextFunction } from 'express';
import { getActiveAnnouncement } from './announcement.service';

const router = Router();

// Public — the app fetches this on launch / foreground. Intentionally
// unauthenticated so a maintenance notice can show even on the splash/login
// screen. Returns `{ announcement: null }` when there's nothing to show.
router.get(
  '/active',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const announcement = await getActiveAnnouncement();
      res.json({ announcement });
    } catch (err) {
      next(err);
    }
  },
);

export const announcementRouter = router;
