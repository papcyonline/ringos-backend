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
      if (result.flagged) {
        return next(new BadRequestError('Message contains inappropriate content', 'CONTENT_FLAGGED'));
      }
      req.body[field] = result.cleaned;
      next();
    } catch (err) {
      logger.warn({ err, userId: req.user?.userId }, 'Content moderation failed, proceeding with original content');
      next();
    }
  };
}
