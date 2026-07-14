import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  createResult: [] as any[],
  createQueue: [] as any[][],
  createThrows: false,
  framesReturn: [] as Buffer[],
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/env', () => ({ env: { OPENAI_API_KEY: 'test-key' } }));

vi.mock('../../config/openai', () => ({
  createOpenAIClient: () => ({
    moderations: {
      create: vi.fn(async () => {
        if (h.createThrows) throw new Error('api down');
        return { results: h.createQueue.length ? h.createQueue.shift() : h.createResult };
      }),
    },
  }),
}));

vi.mock('sharp', () => {
  const chain: any = {
    rotate: () => chain,
    flatten: () => chain,
    jpeg: () => chain,
    toBuffer: async () => Buffer.from('jpeg-bytes'),
  };
  return { default: vi.fn(() => chain) };
});

vi.mock('../video.service', () => ({
  extractFrames: vi.fn(async () => h.framesReturn),
}));

const result = (o: { sexual?: number; graphic?: number; minors?: number }) => ({
  flagged: false,
  categories: {},
  category_scores: {
    sexual: o.sexual ?? 0,
    'violence/graphic': o.graphic ?? 0,
    'sexual/minors': o.minors ?? 0,
  },
});

const originalEnv = process.env;
beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  h.createResult = [result({ sexual: 0 })];
  h.createQueue = [];
  h.createThrows = false;
  h.framesReturn = [Buffer.from('frame')];
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = originalEnv;
});

describe('moderation.service (OpenAI)', () => {
  describe('containsExplicitText', () => {
    it('flags explicit + leet-speak, ignores clean text', async () => {
      const { containsExplicitText } = await import('../moderation.service');
      expect(containsExplicitText('buy p0rn now')).toBe(true);
      expect(containsExplicitText('hello friend')).toBe(false);
      expect(containsExplicitText('a classic tale')).toBe(false);
    });
  });

  describe('moderateImageBuffer', () => {
    it('passes safe images', async () => {
      h.createResult = [result({ sexual: 0.02 })];
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(true);
    });

    it('blocks sexual content over threshold', async () => {
      h.createResult = [result({ sexual: 0.92 })];
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.safe).toBe(false);
      expect(r.reason).toMatch(/nudity|sexual/i);
    });

    it('blocks sexual/minors even below the adult sexual threshold', async () => {
      h.createResult = [result({ minors: 0.5, sexual: 0.1 })];
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
    });

    it('blocks graphic violence over threshold', async () => {
      h.createResult = [result({ graphic: 0.9 })];
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
    });

    it('respects the sexual 0.7 boundary', async () => {
      const { moderateImageBuffer } = await import('../moderation.service');
      h.createResult = [result({ sexual: 0.69 })];
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(true);
      h.createResult = [result({ sexual: 0.71 })];
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
    });

    it('unavailable (fail-OPEN in non-prod) when the API errors', async () => {
      process.env.NODE_ENV = 'test';
      h.createThrows = true;
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(true);
    });

    it('fails CLOSED in production when the API errors', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.MODERATION_FAIL_OPEN;
      h.createThrows = true;
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(false);
    });
  });

  describe('moderateVideoBuffer', () => {
    it('takes the worst frame (one request per frame)', async () => {
      h.framesReturn = [Buffer.from('a'), Buffer.from('b')];
      h.createQueue = [[result({ sexual: 0.01 })], [result({ sexual: 0.95 })]];
      const { moderateVideoBuffer } = await import('../moderation.service');
      expect((await moderateVideoBuffer(Buffer.from('vid'))).safe).toBe(false);
    });

    it('passes a clean video', async () => {
      h.framesReturn = [Buffer.from('a'), Buffer.from('b')];
      h.createResult = [result({ sexual: 0.01 }), result({ sexual: 0.02 })];
      const { moderateVideoBuffer } = await import('../moderation.service');
      expect((await moderateVideoBuffer(Buffer.from('vid'))).safe).toBe(true);
    });

    it('unavailable when no frames decode', async () => {
      process.env.NODE_ENV = 'test';
      h.framesReturn = [];
      const { moderateVideoBuffer } = await import('../moderation.service');
      const r = await moderateVideoBuffer(Buffer.from('vid'));
      expect(r.unavailable).toBe(true);
    });
  });
});
