import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { createMatchRequestSchema } from './matching.schema';
import * as matchingService from './matching.service';
import { getIO } from '../../config/socket';

const router = Router();

// POST /requests - Create a match request
router.post(
  '/requests',
  authenticate,
  validate(createMatchRequestSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { request, matchResult } = await matchingService.createMatchRequest(
        req.user!.userId,
        req.body,
      );

      // If a match was found immediately, emit socket events to both users
      if (matchResult) {
        const io = getIO();
        const { conversation, matchedUserId, requestUserId, score } = matchResult;

        const payload = {
          conversationId: conversation.id,
          participants: conversation.participants,
          score,
        };

        io.to(`user:${requestUserId}`).emit('matching:found', payload);
        io.to(`user:${matchedUserId}`).emit('matching:found', payload);
      }

      res.status(201).json({
        request,
        matched: !!matchResult,
        conversation: matchResult?.conversation ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /requests/:requestId - Cancel a match request
router.delete(
  '/requests/:requestId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const cancelled = await matchingService.cancelMatchRequest(
        req.params.requestId,
        req.user!.userId,
      );
      res.json(cancelled);
    } catch (err) {
      next(err);
    }
  },
);

// GET /requests/active - Get the current user's active waiting request
router.get(
  '/requests/active',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const request = await matchingService.getActiveRequest(req.user!.userId);
      res.json({ request: request ?? null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as matchingRouter };
