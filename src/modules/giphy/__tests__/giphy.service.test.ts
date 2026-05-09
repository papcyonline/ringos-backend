import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config/env', () => ({ env: { GIPHY_API_KEY: 'k' } }));

let originalFetch: any;

beforeEach(() => {
  vi.resetModules();
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

describe('giphy.service (configured)', () => {
  it('getTrending normalizes results', async () => {
    mockFetch({
      data: [
        {
          id: 'g1',
          images: {
            fixed_width: { url: 'fw.gif', width: '200', height: '200' },
            fixed_width_small: { url: 'fws.gif' },
          },
        },
        {
          id: 'g2',
          images: {
            downsized: { url: 'd.gif', width: '300', height: '300' },
          },
        },
        // skipped — no usable image
        { id: 'g3', images: {} },
      ],
    });
    const { getTrending } = await import('../giphy.service');
    const res = await getTrending(10, 0);
    expect(res).toHaveLength(2);
    expect(res[0].previewUrl).toBe('fws.gif');
    expect(res[1].previewUrl).toBe('d.gif');
  });

  it('searchGifs forwards query', async () => {
    mockFetch({ data: [] });
    const { searchGifs } = await import('../giphy.service');
    const res = await searchGifs('cat', 5, 0);
    expect(res).toEqual([]);
  });

  it('throws AppError on non-ok response', async () => {
    mockFetch({}, false, 500);
    const { getTrending } = await import('../giphy.service');
    await expect(getTrending(10, 0)).rejects.toThrow(/Giphy/);
  });

  it('returns empty when no data field', async () => {
    mockFetch({});
    const { getTrending } = await import('../giphy.service');
    const res = await getTrending(10, 0);
    expect(res).toEqual([]);
  });
});

describe('giphy.service (not configured)', () => {
  beforeEach(() => {
    vi.doMock('../../../config/env', () => ({ env: { GIPHY_API_KEY: undefined } }));
  });

  it('getTrending throws when missing API key', async () => {
    const { getTrending } = await import('../giphy.service');
    await expect(getTrending(10, 0)).rejects.toThrow(/not configured/);
  });
});
