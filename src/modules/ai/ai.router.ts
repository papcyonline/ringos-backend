import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { startSessionSchema, sendMessageSchema } from './ai.schema';
import * as aiService from './ai.service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

const router = Router();

// POST /sessions - Start a new AI session
router.post(
  '/sessions',
  authenticate,
  validate(startSessionSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const session = await aiService.startSession(req.user!.userId, req.body.mode);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  },
);

// POST /sessions/:sessionId/messages - Send a text message
router.post(
  '/sessions/:sessionId/messages',
  authenticate,
  validate(sendMessageSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await aiService.sendMessage(
        req.params.sessionId,
        req.user!.userId,
        req.body.content,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /sessions/:sessionId/audio - Send an audio message
router.post(
  '/sessions/:sessionId/audio',
  authenticate,
  upload.single('audio'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      const result = await aiService.sendAudio(
        req.params.sessionId,
        req.user!.userId,
        req.file.buffer,
        req.file.mimetype,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /sessions/:sessionId/end - End a session
router.post(
  '/sessions/:sessionId/end',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await aiService.endSession(req.params.sessionId, req.user!.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// GET /sessions/:sessionId - Get a session with messages
router.get(
  '/sessions/:sessionId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const session = await aiService.getSession(req.params.sessionId, req.user!.userId);
      res.json(session);
    } catch (err) {
      next(err);
    }
  },
);

// GET /sessions - List user's sessions
router.get(
  '/sessions',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const sessions = await aiService.getSessions(req.user!.userId);
      res.json(sessions);
    } catch (err) {
      next(err);
    }
  },
);

export { router as aiRouter };
