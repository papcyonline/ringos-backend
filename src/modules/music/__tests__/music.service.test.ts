import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let originalFetch: any;

beforeEach(() => {
  originalFetch = (global as any).fetch;
});

afterEach(() => {
  (global as any).fetch = originalFetch;
});

function mockFetch(payload: any, ok = true, status = 200) {
  (global as any).fetch = vi.fn().mockResolvedValue({
    ok, status,
    json: async () => payload,
  });
}

import { searchMusic, getTrending } from '../music.service';

describe('music.service', () => {
  it('searchMusic normalizes results and bumps artwork size', async () => {
    mockFetch({
      results: [
        {
          trackId: 1,
          trackName: 'Song',
          artistName: 'Artist',
          artworkUrl100: 'https://x/100x100bb.png',
          previewUrl: 'preview.m4a',
          trackTimeMillis: 240_000,
        },
        // skipped — no preview
        { trackId: 2, trackName: 'No preview' },
        // skipped — no trackName
        { trackId: 3, previewUrl: 'p.m4a' },
      ],
    });
    const res = await searchMusic('test', 10);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('1');
    expect(res[0].artworkUrl).toMatch(/300x300bb/);
    expect(res[0].durationMs).toBe(240_000);
  });

  it('uses 60x60 fallback when no 100x100', async () => {
    mockFetch({
      results: [{
        trackId: 1, trackName: 'X', artistName: 'A',
        artworkUrl60: 'https://x/60x60bb.png',
        previewUrl: 'p.m4a',
      }],
    });
    const res = await searchMusic('q', 5);
    expect(res[0].artworkUrl).toMatch(/300x300bb/);
  });

  it('defaults durationMs when missing', async () => {
    mockFetch({
      results: [{ trackId: 1, trackName: 'X', previewUrl: 'p.m4a' }],
    });
    const res = await searchMusic('q', 1);
    expect(res[0].durationMs).toBe(30_000);
  });

  it('throws on iTunes error', async () => {
    mockFetch({}, false, 502);
    await expect(searchMusic('q', 5)).rejects.toThrow(/iTunes/);
  });

  it('getTrending uses default query', async () => {
    mockFetch({ results: [] });
    const res = await getTrending(10);
    expect(res).toEqual([]);
    expect((global as any).fetch).toHaveBeenCalled();
    const calledUrl = (global as any).fetch.mock.calls[0][0];
    expect(calledUrl).toContain('top+hits');
  });

  it('returns empty when no results array', async () => {
    mockFetch({});
    const res = await searchMusic('q', 1);
    expect(res).toEqual([]);
  });
});
