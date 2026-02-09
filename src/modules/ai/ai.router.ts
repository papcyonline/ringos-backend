import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { startSessionSchema, sendMessageSchema } from './ai.schema';
import * as aiService from './ai.service';
import { synthesizeSpeech } from './tts.service';
import { promptMap } from './prompts';
import { env } from '../../config/env';
import { checkKoraSession, incrementKoraSession, checkKoraMessages, incrementKoraMessage } from '../../shared/usage.service';

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
      // Check daily session limit for free users
      const sessionCheck = await checkKoraSession(req.user!.userId);
      if (!sessionCheck.allowed) {
        return res.status(403).json({
          message: 'Daily Kora session limit reached',
          code: 'KORA_SESSION_LIMIT',
          resetAt: sessionCheck.resetAt,
        });
      }

      const session = await aiService.startSession(req.user!.userId, req.body.mode);

      // Increment session count on success
      await incrementKoraSession(req.user!.userId);

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
        (req.params.sessionId as string),
        req.user!.userId,
        req.body.content,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /sessions/:sessionId/messages/stream - Stream a text message response (SSE)
router.post(
  '/sessions/:sessionId/messages/stream',
  authenticate,
  validate(sendMessageSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    // Check per-session message limit before opening SSE
    const msgCheck = await checkKoraMessages(req.user!.userId, (req.params.sessionId as string));
    if (!msgCheck.allowed) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Message limit reached for this session', code: 'KORA_MESSAGE_LIMIT' })}\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    try {
      // Increment message count
      await incrementKoraMessage(req.user!.userId, (req.params.sessionId as string));

      await aiService.sendMessageStream(
        (req.params.sessionId as string),
        req.user!.userId,
        req.body.content,
        (token) => {
          res.write(`data: ${JSON.stringify({ type: 'token', text: token })}\n\n`);
        },
        (meta) => {
          res.write(`data: ${JSON.stringify({ type: 'done', ...meta })}\n\n`);
          res.end();
        },
        (action) => {
          res.write(`data: ${JSON.stringify({ type: 'action', actionType: action.actionType, data: action.data })}\n\n`);
        },
      );
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
      res.end();
    }
  },
);

// POST /sessions/:sessionId/audio/stream - Stream an audio message response (SSE)
router.post(
  '/sessions/:sessionId/audio/stream',
  authenticate,
  upload.single('audio'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    try {
      if (!req.file) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'No audio file provided' })}\n\n`);
        res.end();
        return;
      }

      await aiService.sendAudioStream(
        (req.params.sessionId as string),
        req.user!.userId,
        req.file.buffer,
        req.file.mimetype,
        (token) => {
          res.write(`data: ${JSON.stringify({ type: 'token', text: token })}\n\n`);
        },
        (meta) => {
          res.write(`data: ${JSON.stringify({ type: 'done', ...meta })}\n\n`);
          res.end();
        },
        (action) => {
          res.write(`data: ${JSON.stringify({ type: 'action', actionType: action.actionType, data: action.data })}\n\n`);
        },
      );
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
      res.end();
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
        (req.params.sessionId as string),
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

// POST /tts - Convert text to speech audio
router.post(
  '/tts',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'text field is required' });
      }

      const audioBuffer = await synthesizeSpeech(text);
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
      });
      res.send(audioBuffer);
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
      await aiService.endSession((req.params.sessionId as string), req.user!.userId);
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
      const session = await aiService.getSession((req.params.sessionId as string), req.user!.userId);
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

// POST /realtime/token - Get ephemeral token for Gemini Live API
router.post(
  '/realtime/token',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Voice mode runs within an already-started session (POST /sessions
      // already checked + incremented the daily counter). No session-limit
      // check needed here — blocking would prevent voice on the user's
      // last allowed session because the counter was already bumped.

      const { mode = 'CALM_LISTENER' } = req.body;
      const prompt =
        promptMap[mode as keyof typeof promptMap] ?? promptMap.CALM_LISTENER;
      // Strip both the APP ACTIONS block (tools aren't available in voice mode)
      // and the RESPONSE FORMAT block from the voice prompt.
      const voicePrompt = prompt.replace(
        /APP ACTIONS[\s\S]*$/,
        'Respond naturally in a warm, conversational tone. Keep responses short — 1 to 3 sentences max, like a real voice conversation. Do not use JSON formatting.',
      );

      // Personalise with user context
      const userContext = await aiService.getUserContext(req.user!.userId);
      const systemInstruction = userContext
        ? `${voicePrompt}\n\n${userContext}\n\nUse this information naturally in conversation when relevant — don't force it into every message, but use it the way a friend would.`
        : voicePrompt;

      // Pass API key directly — the client connects to Google's WS from the
      // device, but the key is only transmitted over the authenticated
      // backend→client channel, never embedded in the app binary.
      res.json({
        token: env.GEMINI_API_KEY,
        systemInstruction,
        voice: 'Kore',
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as aiRouter };
