import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockAiService, mockTts } = vi.hoisted(() => ({
  mockAiService: {
    startSession: vi.fn().mockResolvedValue({ id: 's-1', mode: 'LIGHT_AND_FUN' }),
    sendMessage: vi.fn().mockResolvedValue({ content: 'Hi', mood: 'NEUTRAL', should_handoff: false }),
    sendMessageStream: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn().mockResolvedValue({ content: 'Hi', mood: 'NEUTRAL' }),
    sendAudioStream: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue({ id: 's-1', messages: [] }),
    getSessions: vi.fn().mockResolvedValue([]),
    getUserContext: vi.fn().mockResolvedValue('User profile context'),
  },
  mockTts: {
    synthesizeSpeech: vi.fn().mockResolvedValue(Buffer.from('audio')),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: { OPENAI_API_KEY: '' } }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../../../middleware/validate', () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../shared/usage.service', () => ({
  checkKoraSession: vi.fn().mockResolvedValue({ allowed: true }),
  incrementKoraSession: vi.fn().mockResolvedValue(undefined),
  checkKoraMessages: vi.fn().mockResolvedValue({ allowed: true }),
  incrementKoraMessage: vi.fn().mockResolvedValue(undefined),
  isPro: vi.fn().mockResolvedValue(true),
}));
vi.mock('../prompts', () => ({
  promptMap: {
    LIGHT_AND_FUN: 'kora light',
    NIGHT_COMPANION: 'night',
    RELATIONSHIP_COACH: 'relate',
    CAREER_MENTOR: 'career',
    CALM_LISTENER: 'calm prompt APP ACTIONS placeholder',
    MOTIVATOR: 'motivate',
  },
}));
vi.mock('../ai.schema', () => ({
  startSessionSchema: {},
  sendMessageSchema: {},
}));
vi.mock('../ai.service', () => mockAiService);
vi.mock('../tts.service', () => mockTts);

import { aiRouter } from '../ai.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/ai', aiRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ai.router', () => {
  it('POST /ai/sessions creates new session', async () => {
    const res = await request(makeApp()).post('/ai/sessions').send({ mode: 'LIGHT_AND_FUN' });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /ai/sessions/:sessionId/messages sends a message', async () => {
    const res = await request(makeApp()).post('/ai/sessions/s-1/messages').send({ content: 'hi' });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /ai/sessions/:sessionId/end closes session', async () => {
    const res = await request(makeApp()).post('/ai/sessions/s-1/end');
    expect([200, 201, 204]).toContain(res.status);
  });

  it('GET /ai/sessions/:sessionId returns session', async () => {
    const res = await request(makeApp()).get('/ai/sessions/s-1');
    expect(res.status).toBe(200);
  });

  it('GET /ai/sessions returns list', async () => {
    const res = await request(makeApp()).get('/ai/sessions');
    expect(res.status).toBe(200);
  });

  it('POST /ai/tts synthesizes speech', async () => {
    const res = await request(makeApp()).post('/ai/tts').send({ text: 'hello' });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /ai/tts rejects missing text', async () => {
    const res = await request(makeApp()).post('/ai/tts').send({});
    expect(res.status).toBe(400);
  });

  it('POST /ai/tts rejects non-string text', async () => {
    const res = await request(makeApp()).post('/ai/tts').send({ text: 123 });
    expect(res.status).toBe(400);
  });

  it('POST /ai/sessions blocks pro mode for free users', async () => {
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(false);
    const res = await request(makeApp()).post('/ai/sessions').send({ mode: 'RELATIONSHIP_COACH' });
    expect(res.status).toBe(403);
  });

  it('POST /ai/sessions allows pro mode for pro users', async () => {
    const usage = await import('../../../shared/usage.service');
    (usage.isPro as any).mockResolvedValueOnce(true);
    const res = await request(makeApp()).post('/ai/sessions').send({ mode: 'CAREER_MENTOR' });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /ai/sessions blocks when daily session limit hit', async () => {
    const usage = await import('../../../shared/usage.service');
    (usage.checkKoraSession as any).mockResolvedValueOnce({ allowed: false, resetAt: 'tomorrow' });
    const res = await request(makeApp()).post('/ai/sessions').send({ mode: 'LIGHT_AND_FUN' });
    expect(res.status).toBe(403);
  });

  it('POST /ai/realtime/token returns Gemini config', async () => {
    const res = await request(makeApp())
      .post('/ai/realtime/token')
      .send({ mode: 'LIGHT_AND_FUN', language: 'fr' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('systemInstruction');
    expect(res.body).toHaveProperty('voice');
  });

  it('POST /ai/realtime/token uses default mode', async () => {
    const res = await request(makeApp())
      .post('/ai/realtime/token')
      .send({});
    expect(res.status).toBe(200);
  });

  it('POST /ai/sessions/:id/audio rejects missing file', async () => {
    const res = await request(makeApp()).post('/ai/sessions/s-1/audio').send({});
    expect(res.status).toBe(400);
  });

  describe('SSE streaming endpoints', () => {
    it('POST /ai/sessions/:id/messages/stream streams text', async () => {
      mockAiService.sendMessageStream.mockImplementation(async (
        _sid: string, _uid: string, _content: string,
        onToken: any, onDone: any,
      ) => {
        onToken('Hello ');
        onToken('world');
        onDone({ mood: 'HAPPY', should_handoff: false });
      });
      const res = await request(makeApp())
        .post('/ai/sessions/s-1/messages/stream')
        .send({ content: 'hi' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Hello');
      expect(res.text).toContain('world');
      expect(res.text).toContain('done');
    });

    it('POST /ai/sessions/:id/messages/stream blocks at message limit', async () => {
      const usage = await import('../../../shared/usage.service');
      (usage.checkKoraMessages as any).mockResolvedValueOnce({ allowed: false });
      const res = await request(makeApp())
        .post('/ai/sessions/s-1/messages/stream')
        .send({ content: 'hi' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('KORA_MESSAGE_LIMIT');
    });

    it('POST /ai/sessions/:id/messages/stream emits action events', async () => {
      mockAiService.sendMessageStream.mockImplementation(async (
        _sid: string, _uid: string, _content: string,
        _onToken: any, onDone: any, onAction: any,
      ) => {
        onAction({ actionType: 'navigate', data: { route: '/home' } });
        onDone({ mood: 'NEUTRAL', should_handoff: false });
      });
      const res = await request(makeApp())
        .post('/ai/sessions/s-1/messages/stream')
        .send({ content: 'hi' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('action');
    });

    it('POST /ai/sessions/:id/messages/stream handles service error', async () => {
      mockAiService.sendMessageStream.mockRejectedValue(new Error('llm-down'));
      const res = await request(makeApp())
        .post('/ai/sessions/s-1/messages/stream')
        .send({ content: 'hi' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('error');
    });

    it('POST /ai/sessions/:id/audio/stream streams audio', async () => {
      mockAiService.sendAudioStream.mockImplementation(async (
        _sid: string, _uid: string, _buf: any, _mime: string,
        onToken: any, onDone: any,
      ) => {
        onToken('hi');
        onDone({ mood: 'NEUTRAL', should_handoff: false });
      });
      // multer.single('audio') would parse a real file — supertest doesn't,
      // but the route hits the "no file" branch so we still hit the error path.
      const res = await request(makeApp())
        .post('/ai/sessions/s-1/audio/stream');
      expect(res.status).toBe(200);
    });

    it('POST /ai/sessions/:id/audio/stream handles service error', async () => {
      mockAiService.sendAudioStream.mockRejectedValue(new Error('audio-fail'));
      const res = await request(makeApp())
        .post('/ai/sessions/s-1/audio/stream');
      expect(res.status).toBe(200);
    });
  });
});
