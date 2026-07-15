import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import * as referralService from './referral.service';
import { redeemReferralSchema } from './referral.schema';

const router = Router();

// Invite & Earn screen data: code, share link, friends joined, rewards.
router.get(
  '/me',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const summary = await referralService.getReferralSummary(req.user!.userId);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  },
);

// Redeem an invite code. If the user is already onboarded, qualify right away;
// otherwise qualification fires when they finish onboarding (setUsername).
router.post(
  '/redeem',
  authenticate,
  validate(redeemReferralSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await referralService.redeemCode(req.user!.userId, req.body.code);
      await referralService.qualifyReferral(req.user!.userId).catch(() => {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export const referralRouter = router;
