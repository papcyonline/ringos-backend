import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mutable state the mocks read from (hoisted so vi.mock factories can
// reference it safely).
const h = vi.hoisted(() => ({
  classifyReturn: [] as { className: string; probability: number }[],
  classifyQueue: [] as { className: string; probability: number }[][],
  framesReturn: [] as Buffer[],
  classifyThrows: false,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('nsfwjs', () => ({
  load: vi.fn(async () => ({
    classify: vi.fn(async () => {
      if (h.classifyThrows) throw new Error('model unavailable');
      return h.classifyQueue.length ? h.classifyQueue.shift() : h.classifyReturn;
    }),
  })),
}));

vi.mock('@tensorflow/tfjs-node', () => ({
  node: { decodeImage: vi.fn(() => ({ dispose: vi.fn() })) },
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

const preds = (o: Partial<Record<'porn' | 'hentai' | 'sexy' | 'neutral' | 'drawing', number>>) => [
  { className: 'Porn', probability: o.porn ?? 0 },
  { className: 'Hentai', probability: o.hentai ?? 0 },
  { className: 'Sexy', probability: o.sexy ?? 0 },
  { className: 'Neutral', probability: o.neutral ?? 1 },
  { className: 'Drawing', probability: o.drawing ?? 0 },
];

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  h.classifyReturn = preds({ neutral: 1 });
  h.classifyQueue = [];
  h.framesReturn = [Buffer.from('frame')];
  h.classifyThrows = false;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

describe('moderation.service (NSFWJS)', () => {
  describe('containsExplicitText', () => {
    it('flags explicit words and leet-speak, ignores clean text', async () => {
      const { containsExplicitText } = await import('../moderation.service');
      expect(containsExplicitText('check out my p0rn')).toBe(true);
      expect(containsExplicitText('hello there friend')).toBe(false);
      expect(containsExplicitText('a classic story')).toBe(false); // "ass" substring not flagged
    });
  });

  describe('moderateImageBuffer', () => {
    it('passes safe (neutral) images', async () => {
      h.classifyReturn = preds({ neutral: 0.98 });
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(true);
    });

    it('blocks Porn over the threshold', async () => {
      h.classifyReturn = preds({ porn: 0.92 });
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.safe).toBe(false);
      expect(r.reason).toMatch(/nudity|sexual/i);
    });

    it('blocks Hentai over the threshold', async () => {
      h.classifyReturn = preds({ hentai: 0.8 });
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
    });

    it('does NOT block merely "Sexy" images (bikini/cleavage false-positives)', async () => {
      h.classifyReturn = preds({ sexy: 0.95, neutral: 0.05 });
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(true);
    });

    it('respects the 0.7 threshold boundary', async () => {
      const { moderateImageBuffer } = await import('../moderation.service');
      h.classifyReturn = preds({ porn: 0.69 });
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(true);
      h.classifyReturn = preds({ porn: 0.71 });
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
    });
  });

  describe('moderateVideoBuffer', () => {
    it('takes the worst frame across the sampled frames', async () => {
      h.framesReturn = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
      h.classifyQueue = [preds({ neutral: 1 }), preds({ porn: 0.9 }), preds({ neutral: 1 })];
      const { moderateVideoBuffer } = await import('../moderation.service');
      expect((await moderateVideoBuffer(Buffer.from('vid'))).safe).toBe(false);
    });

    it('passes a clean video', async () => {
      h.framesReturn = [Buffer.from('a'), Buffer.from('b')];
      h.classifyReturn = preds({ neutral: 1 });
      const { moderateVideoBuffer } = await import('../moderation.service');
      expect((await moderateVideoBuffer(Buffer.from('vid'))).safe).toBe(true);
    });

    it('reports unavailable when frames exist but none classify (model outage)', async () => {
      process.env.NODE_ENV = 'test';
      h.framesReturn = [Buffer.from('a'), Buffer.from('b')];
      h.classifyThrows = true;
      const { moderateVideoBuffer } = await import('../moderation.service');
      const r = await moderateVideoBuffer(Buffer.from('vid'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(true); // non-prod fail-open
    });

    it('returns unavailable (fail-OPEN in non-prod) when no frames decode', async () => {
      process.env.NODE_ENV = 'test';
      h.framesReturn = [];
      const { moderateVideoBuffer } = await import('../moderation.service');
      const r = await moderateVideoBuffer(Buffer.from('vid'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(true);
    });

    it('fails CLOSED on unavailable in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.MODERATION_FAIL_OPEN;
      h.framesReturn = [];
      const { moderateVideoBuffer } = await import('../moderation.service');
      const r = await moderateVideoBuffer(Buffer.from('vid'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(false);
    });
  });
});
