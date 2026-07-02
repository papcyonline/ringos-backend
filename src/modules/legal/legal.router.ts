import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import {
  getCurrentLegal,
  recordConsent,
  CURRENT_LEGAL_VERSION,
} from './legal.service';

const router = Router();

// Public — the app fetches the current legal version + document URLs on launch
// to decide whether the user needs to (re)accept.
router.get('/current', (_req: Request, res: Response) => {
  res.json(getCurrentLegal());
});

// Records that the authenticated user accepted a legal version (onboarding or
// re-consent). Body: { version?, platform?, appVersion? }.
router.post(
  '/accept',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const version = Number(req.body?.version ?? CURRENT_LEGAL_VERSION);
      const platform =
        typeof req.body?.platform === 'string' ? req.body.platform : undefined;
      const appVersion =
        typeof req.body?.appVersion === 'string'
          ? req.body.appVersion
          : undefined;
      await recordConsent(userId, version, platform, appVersion);
      res.json({ ok: true, version });
    } catch (err) {
      next(err);
    }
  },
);

export const legalRouter = router;
