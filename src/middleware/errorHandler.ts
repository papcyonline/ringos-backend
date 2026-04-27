import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors';
import { logger } from '../shared/logger';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { message: err.message, code: err.code },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
  }

  // ── Upload errors — multer fileFilter rejections + size limits ───────
  // These come back as plain Errors (or MulterError for size limits).
  // Surface the human message + correct status so the client can show a
  // friendly toast instead of "Internal server error".
  if (err instanceof MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large'
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Unexpected file in upload'
        : err.message;
    return res.status(413).json({
      error: { message: msg, code: 'UPLOAD_LIMIT' },
    });
  }
  if (
    err.message &&
    (err.message.startsWith('Only ') ||
      err.message.startsWith('Unsupported file'))
  ) {
    return res.status(415).json({
      error: { message: err.message, code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
  }

  logger.error(err, 'Unhandled error');
  return res.status(500).json({
    error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
  });
}
