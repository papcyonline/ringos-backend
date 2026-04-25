import { AppError } from '../../shared/errors';

const ITUNES_SEARCH = 'https://itunes.apple.com/search';

export type NormalizedTrack = {
  id: string;
  title: string;
  artist: string;
  artworkUrl: string;
  previewUrl: string;
  durationMs: number;
};

type ItunesResult = {
  trackId: number;
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
};

type ItunesResponse = {
  resultCount?: number;
  results?: ItunesResult[];
};

function normalize(items: ItunesResult[]): NormalizedTrack[] {
  const out: NormalizedTrack[] = [];
  for (const item of items) {
    if (!item.previewUrl || !item.trackName) continue;
    // Bump artwork to a usable size for chat thumbnails.
    const artwork = (item.artworkUrl100 ?? item.artworkUrl60 ?? '')
      .replace(/100x100bb/, '300x300bb')
      .replace(/60x60bb/, '300x300bb');
    out.push({
      id: String(item.trackId),
      title: item.trackName,
      artist: item.artistName ?? '',
      artworkUrl: artwork,
      previewUrl: item.previewUrl,
      durationMs: item.trackTimeMillis ?? 30_000,
    });
  }
  return out;
}

async function call(query: string, limit: number): Promise<NormalizedTrack[]> {
  const qs = new URLSearchParams({
    term: query,
    media: 'music',
    entity: 'song',
    limit: String(limit),
    country: 'us',
  });
  const res = await fetch(`${ITUNES_SEARCH}?${qs.toString()}`);
  if (!res.ok) {
    throw new AppError(502, `iTunes request failed (${res.status})`, 'MUSIC_UPSTREAM');
  }
  const json = (await res.json()) as ItunesResponse;
  return normalize(json.results ?? []);
}

export async function searchMusic(query: string, limit: number): Promise<NormalizedTrack[]> {
  return call(query, limit);
}

export async function getTrending(limit: number): Promise<NormalizedTrack[]> {
  // iTunes Search has no real "trending" endpoint — surface a popular search
  // as the default browsing list. Cheap, keyless, no auth.
  return call('top hits', limit);
}
