import { env } from '../../config/env';
import { AppError } from '../../shared/errors';

const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';

export type NormalizedGif = {
  id: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
};

type GiphyItem = {
  id: string;
  images: {
    fixed_width?: { url: string; width: string; height: string };
    fixed_width_small?: { url: string };
    downsized?: { url: string; width: string; height: string };
  };
};

type GiphyResponse = {
  data?: GiphyItem[];
  pagination?: { total_count: number; count: number; offset: number };
};

function requireKey(): string {
  if (!env.GIPHY_API_KEY) {
    throw new AppError(503, 'GIF picker is not configured', 'GIPHY_NOT_CONFIGURED');
  }
  return env.GIPHY_API_KEY;
}

function normalize(items: GiphyItem[]): NormalizedGif[] {
  const out: NormalizedGif[] = [];
  for (const item of items) {
    const full = item.images.fixed_width ?? item.images.downsized;
    if (!full?.url) continue;
    out.push({
      id: item.id,
      url: full.url,
      previewUrl: item.images.fixed_width_small?.url ?? full.url,
      width: Number(full.width) || 0,
      height: Number(full.height) || 0,
    });
  }
  return out;
}

async function call(endpoint: string, params: Record<string, string>): Promise<NormalizedGif[]> {
  const key = requireKey();
  const qs = new URLSearchParams({ ...params, api_key: key, rating: 'pg-13' });
  const res = await fetch(`${GIPHY_BASE}/${endpoint}?${qs.toString()}`);
  if (!res.ok) {
    throw new AppError(502, `Giphy request failed (${res.status})`, 'GIPHY_UPSTREAM');
  }
  const json = (await res.json()) as GiphyResponse;
  return normalize(json.data ?? []);
}

export async function getTrending(limit: number, offset: number): Promise<NormalizedGif[]> {
  return call('trending', { limit: String(limit), offset: String(offset) });
}

export async function searchGifs(query: string, limit: number, offset: number): Promise<NormalizedGif[]> {
  return call('search', { q: query, limit: String(limit), offset: String(offset) });
}
