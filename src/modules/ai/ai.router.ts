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

// POST /sessions/:sessionId/messages/stream - Stream a text message response (SSE)
router.post(
  '/sessions/:sessionId/messages/stream',
  authenticate,
  validate(sendMessageSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    try {
      await aiService.sendMessageStream(
        req.params.sessionId,
        req.user!.userId,
        req.body.content,
        (token) => {
          res.write(`data: ${JSON.stringify({ type: 'token', text: token })}\n\n`);
        },
        (meta) => {
          res.write(`data: ${JSON.stringify({ type: 'done', ...meta })}\n\n`);
          res.end();
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
        req.params.sessionId,
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

// POST /realtime/token - Get ephemeral token for OpenAI Realtime WebRTC API
router.post(
  '/realtime/token',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { mode = 'CALM_LISTENER' } = req.body;
      const prompt =
        promptMap[mode as keyof typeof promptMap] ?? promptMap.CALM_LISTENER;
      const voicePrompt = prompt.replace(
        /RESPONSE FORMAT:[\s\S]*$/,
        'Respond naturally in a warm, conversational tone. Keep responses short — 1 to 3 sentences max, like a real voice conversation. Do not use JSON formatting.',
      );

      const response = await fetch(
        'https://api.openai.com/v1/realtime/sessions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-realtime-preview-2025-06-03',
            voice: 'shimmer',
            instructions: voicePrompt,
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 200,
              create_response: true,
              interrupt_response: true,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        return res
          .status(response.status)
          .json({ error: `OpenAI session creation failed: ${errorText}` });
      }

      const data = (await response.json()) as any;
      res.json({
        token: data.client_secret?.value,
        expiresAt: data.client_secret?.expires_at,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as aiRouter };
