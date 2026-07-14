import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  flags: { nudity: false, weapons: false, drugs: false, violence: false } as Record<string, boolean>,
  queue: [] as Record<string, boolean>[],
  throws: false,
  framesReturn: [] as Buffer[],
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/env', () => ({ env: { OPENAI_API_KEY: 'test-key' } }));

vi.mock('../../config/openai', () => ({
  createOpenAIClient: () => ({
    chat: {
      completions: {
        create: vi.fn(async () => {
          if (h.throws) throw new Error('api down');
          const flags = h.queue.length ? h.queue.shift() : h.flags;
          return { choices: [{ message: { content: JSON.stringify(flags) } }] };
        }),
      },
    },
  }),
}));

vi.mock('sharp', () => {
  const chain: any = {
    rotate: () => chain,
    flatten: () => chain,
    resize: () => chain,
    jpeg: () => chain,
    toBuffer: async () => Buffer.from('jpeg-bytes'),
  };
  return { default: vi.fn(() => chain) };
});

vi.mock('../video.service', () => ({
  extractFrames: vi.fn(async () => h.framesReturn),
}));

const F = (o: Partial<Record<string, boolean>>) => ({
  nudity: !!o.nudity,
  weapons: !!o.weapons,
  drugs: !!o.drugs,
  violence: !!o.violence,
});

const originalEnv = process.env;
beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  h.flags = F({});
  h.queue = [];
  h.throws = false;
  h.framesReturn = [Buffer.from('frame')];
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = originalEnv;
});

describe('moderation.service (GPT-4o-mini vision)', () => {
  describe('containsExplicitText', () => {
    it('flags explicit + leet-speak, ignores clean text', async () => {
      const { containsExplicitText } = await import('../moderation.service');
      expect(containsExplicitText('buy p0rn now')).toBe(true);
      expect(containsExplicitText('hello friend')).toBe(false);
      expect(containsExplicitText('a classic tale')).toBe(false);
    });
  });

  describe('moderateImageBuffer', () => {
    it('passes clean images', async () => {
      h.flags = F({});
      const { moderateImageBuffer } = await import('../moderation.service');
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(true);
    });

    it('blocks nudity', async () => {
      h.flags = F({ nudity: true });
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.safe).toBe(false);
      expect(r.categories).toContain('nudity');
    });

    it('blocks weapons', async () => {
      h.flags = F({ weapons: true });
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.safe).toBe(false);
      expect(r.categories).toContain('weapons');
    });

    it('blocks drugs and violence', async () => {
      const { moderateImageBuffer } = await import('../moderation.service');
      h.flags = F({ drugs: true });
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
      h.flags = F({ violence: true });
      expect((await moderateImageBuffer(Buffer.from('x'))).safe).toBe(false);
    });

    it('unavailable (fail-OPEN in non-prod) when the API errors', async () => {
      process.env.NODE_ENV = 'test';
      h.throws = true;
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(true);
    });

    it('fails CLOSED in production when the API errors', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.MODERATION_FAIL_OPEN;
      h.throws = true;
      const { moderateImageBuffer } = await import('../moderation.service');
      const r = await moderateImageBuffer(Buffer.from('x'));
      expect(r.unavailable).toBe(true);
      expect(r.safe).toBe(false);
    });
  });

  describe('moderateVideoBuffer', () => {
    it('flags the video if ANY frame is prohibited', async () => {
      h.framesReturn = [Buffer.from('a'), Buffer.from('b')];
      h.queue = [F({}), F({ weapons: true })];
      const { moderateVideoBuffer } = await import('../moderation.service');
      const r = await moderateVideoBuffer(Buffer.from('vid'));
      expect(r.safe).toBe(false);
      expect(r.categories).toContain('weapons');
    });

    it('passes a clean video', async () => {
      h.framesReturn = [Buffer.from('a'), Buffer.from('b')];
      h.flags = F({});
      const { moderateVideoBuffer } = await import('../moderation.service');
      expect((await moderateVideoBuffer(Buffer.from('vid'))).safe).toBe(true);
    });

    it('unavailable when no frames decode', async () => {
      process.env.NODE_ENV = 'test';
      h.framesReturn = [];
      const { moderateVideoBuffer } = await import('../moderation.service');
      expect((await moderateVideoBuffer(Buffer.from('vid'))).unavailable).toBe(true);
    });
  });
});
