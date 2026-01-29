import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { reportSchema, blockSchema } from './safety.schema';
import * as safetyService from './safety.service';
import * as handoffService from './handoff.service';

const router = Router();

const handoffSchema = z.object({
  aiSessionId: z.string().uuid(),
  mood: z.string().optional(),
  intent: z.string().optional(),
});

// POST /report - Report a user
router.post(
  '/report',
  authenticate,
  validate(reportSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const result = await safetyService.reportUser(userId, req.body);
      logger.info({ userId, reportedId: req.body.reportedId }, 'Report submitted');
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /block - Block a user
router.post(
  '/block',
  authenticate,
  validate(blockSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { blockedId } = req.body;
      const result = await safetyService.blockUser(userId, blockedId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /block/:blockedId - Unblock a user
router.delete(
  '/block/:blockedId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { blockedId } = req.params;
      const result = await safetyService.unblockUser(userId, blockedId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /blocked - List blocked users
router.get(
  '/blocked',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const result = await safetyService.getBlockedUsers(userId);
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  },
);

// POST /handoff - AI-to-human handoff
router.post(
  '/handoff',
  authenticate,
  validate(handoffSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { aiSessionId, mood, intent } = req.body;
      const result = await handoffService.createHandoffRequest(userId, aiSessionId, mood, intent);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as safetyRouter };
