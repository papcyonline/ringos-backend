import { Response, NextFunction } from 'express';
import { AuthRequest } from '../shared/types';
import { moderateContent } from '../modules/safety/moderation.service';
import { BadRequestError } from '../shared/errors';
import { logger } from '../shared/logger';

export function moderateMessage(field = 'content') {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const text = req.body[field];
      if (!text || typeof text !== 'string') return next();

      const result = await moderateContent(text);
      if (result.flagged && result.severity === 'hard') {
        return next(new BadRequestError('Message contains inappropriate content', 'CONTENT_FLAGGED'));
      }
      if (result.flagged && result.severity === 'soft') {
        logger.info({ userId: req.user?.userId, reason: result.reason }, 'Soft-warned content allowed through');
      }
      req.body[field] = result.cleaned;
      next();
    } catch (err) {
      logger.warn({ err, userId: req.user?.userId }, 'Content moderation failed, proceeding with original content');
      next();
    }
  };
}
