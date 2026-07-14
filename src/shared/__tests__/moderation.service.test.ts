import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const originalEnv = process.env;
let originalFetch: any;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv, SIGHTENGINE_API_USER: 'u', SIGHTENGINE_API_SECRET: 's' };
  originalFetch = (global as any).fetch;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
  (global as any).fetch = originalFetch;
});

function mockFetch(data: any, ok = true) {
  (global as any).fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
  });
}

describe('moderation.service', () => {
  describe('moderateImageUrl', () => {
    it('returns safe when no API key configured', async () => {
      process.env = { ...originalEnv };
      delete process.env.SIGHTENGINE_API_USER;
      delete process.env.SIGHTENGINE_API_SECRET;
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(true);
    });

    it('returns safe when API errors (fail open)', async () => {
      mockFetch({}, false);
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(true);
    });

    it('returns safe when status is non-success', async () => {
      mockFetch({ status: 'failed' });
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(true);
    });

    it('flags nudity above threshold', async () => {
      mockFetch({
        status: 'success',
        nudity: { sexual_activity: 0.9, sexual_display: 0.1, erotica: 0.1 },
      });
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(false);
      expect(res.reason).toMatch(/nudity/);
    });

    it('flags offensive content', async () => {
      mockFetch({
        status: 'success',
        nudity: {},
        offensive: { prob: 0.9 },
      });
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(false);
      expect(res.reason).toMatch(/offensive/);
    });

    it('flags weapons above threshold', async () => {
      mockFetch({
        status: 'success',
        nudity: {},
        weapon: 0.95,
      });
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(false);
      expect(res.reason).toMatch(/weapon/);
    });

    it('returns safe with scores when below thresholds', async () => {
      mockFetch({
        status: 'success',
        nudity: { sexual_activity: 0.1 },
        offensive: { prob: 0.1 },
        weapon: 0.1,
        recreational_drug: { prob: 0.1 },
      });
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(true);
      expect(res.scores).toBeDefined();
    });

    it('catches fetch exceptions and returns safe', async () => {
      (global as any).fetch = vi.fn().mockRejectedValue(new Error('network'));
      const { moderateImageUrl } = await import('../moderation.service');
      const res = await moderateImageUrl('https://x/img.jpg');
      expect(res.safe).toBe(true);
    });
  });

  describe('moderateVideoUrl', () => {
    it('returns safe when no API key configured', async () => {
      process.env = { ...originalEnv };
      delete process.env.SIGHTENGINE_API_USER;
      delete process.env.SIGHTENGINE_API_SECRET;
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(true);
    });

    it('returns safe on API error', async () => {
      mockFetch({}, false);
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(true);
    });

    it('returns safe on non-success status', async () => {
      mockFetch({ status: 'failed' });
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(true);
    });

    it('flags video nudity', async () => {
      mockFetch({
        status: 'success',
        data: { frames: [{ nudity: { sexual_activity: 0.95 } }] },
      });
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(false);
      expect(res.reason).toMatch(/nudity/);
    });

    it('flags video offensive', async () => {
      mockFetch({
        status: 'success',
        data: { frames: [{ nudity: {}, offensive: { prob: 0.95 } }] },
      });
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(false);
      expect(res.reason).toMatch(/offensive/);
    });

    it('flags video weapons', async () => {
      mockFetch({
        status: 'success',
        data: { frames: [{ nudity: {}, weapon: 0.9 }] },
      });
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(false);
      expect(res.reason).toMatch(/weapon/);
    });

    it('returns safe with no frames', async () => {
      mockFetch({ status: 'success', data: { frames: [] } });
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(true);
    });

    it('catches video fetch exceptions', async () => {
      (global as any).fetch = vi.fn().mockRejectedValue(new Error('network'));
      const { moderateVideoUrl } = await import('../moderation.service');
      const res = await moderateVideoUrl('https://x/v.mp4');
      expect(res.safe).toBe(true);
    });
  });
});
