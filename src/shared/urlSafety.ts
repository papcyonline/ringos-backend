/**
 * Link safety for user-generated content (currently story captions).
 *
 * Clickable story links come from URLs typed into a caption. This module is the
 * server-side gate that keeps porn / dangerous links off the platform — enforced
 * at post time (see story.service) so it can't be bypassed by a modified client.
 * The Flutter client mirrors the same lists in `core/utils/url_safety.dart` for
 * instant feedback + a tap-time guard, but THIS is the authority.
 *
 * Heuristic denylist (no external API): adult TLDs, adult host keywords chosen
 * to be substring-safe (they don't appear inside common legitimate words),
 * raw-IP hosts, and direct executable/installer downloads.
 */

// URLs inside free text — protocol optional (matches the client regex).
const URL_REGEX =
  /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;

// TLDs that are effectively adult-only — matched on the host suffix.
const ADULT_TLDS = ['.xxx', '.porn', '.porno', '.adult', '.sex', '.sexy'];

// Adult host tokens. Every entry is chosen so that a plain substring match will
// NOT hit ordinary words/domains — we deliberately avoid bare "sex" (essex),
// "anal" (analytics), "cam" (camera), "jav" (java) and "kink" (kinkos), using
// compounds/brands instead. Matched against the hostname only. Note most
// *porn* / *xxx* / *hentai* sites are already caught by those three tokens.
const ADULT_HOST_KEYWORDS = [
  // core tokens (catch the long tail of *porn* / *xxx* / *hentai* domains)
  'porn', 'xxx', 'hentai',
  // sex-* compounds (bare "sex" is unsafe)
  'sexcam', 'sexchat', 'sextube', 'sextape', 'sexvid',
  // tube / aggregator sites without a core token
  'xvideos', 'xnxx', 'xhamster', 'redtube', 'jizz', 'tube8', 'spankbang',
  'spankwire', 'keezmovies', 'extremetube', 'beeg', 'tnaflix', 'empflix',
  'drtuber', 'nuvid', '4tube', 'thumbzilla', 'motherless', 'youjizz',
  // studios / networks
  'brazzers', 'bangbros', 'realitykings', 'naughtyamerica', 'mofos',
  'digitalplayground', 'teamskeet', 'twistys', 'evilangel', 'metart', 'tushy',
  // creator / leak sites
  'onlyfans', 'fansly', 'fapello', 'faphouse', 'redgifs', 'erome',
  'coomer', 'kemono', 'thothub', 'simpcity',
  // live cam sites (bare "cam" is unsafe)
  'chaturbate', 'stripchat', 'bongacams', 'livejasmin', 'myfreecams',
  'camsoda', 'cam4', 'camwhores', 'recurbate', 'streamate', 'flirt4free',
  'imlive', 'xlovecam', 'camgirl',
  // hentai / JAV (bare "jav" is unsafe)
  'nhentai', 'hanime', 'fakku', 'iwara', 'gelbooru', 'danbooru', 'rule34',
  'javhd', 'javbus', 'javfinder', 'javlibrary', 'javguru',
  // misc strong signals
  'adultfriendfinder', 'adultwork', 'nsfw', 'milf', 'boobs', 'nudes',
  'escort', 'fuckbook',
];

// Direct downloads we never want a story link to hand off to.
const DANGEROUS_EXTENSIONS = [
  '.apk', '.exe', '.scr', '.bat', '.cmd', '.msi', '.msix', '.dmg', '.jar',
  '.vbs', '.ps1', '.app', '.deb',
];

const RAW_IP_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface LinkVerdict {
  safe: boolean;
  reason?: string;
}

/** Classify a single URL. Unparseable input is treated as safe here (the
 *  client's openExternalLink still validates the scheme before launching). */
export function classifyUrl(rawUrl: string): LinkVerdict {
  let candidate = rawUrl.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  let host: string;
  let path: string;
  try {
    const u = new URL(candidate);
    host = u.hostname.toLowerCase();
    path = decodeURIComponent(u.pathname).toLowerCase();
  } catch {
    return { safe: true };
  }

  if (ADULT_TLDS.some((tld) => host.endsWith(tld))) {
    return { safe: false, reason: 'Adult links aren’t allowed on stories.' };
  }
  if (ADULT_HOST_KEYWORDS.some((kw) => host.includes(kw))) {
    return { safe: false, reason: 'Adult links aren’t allowed on stories.' };
  }
  if (RAW_IP_HOST.test(host)) {
    return { safe: false, reason: 'This link looks unsafe and was blocked.' };
  }
  if (DANGEROUS_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return { safe: false, reason: 'Links to app/executable files aren’t allowed.' };
  }
  return { safe: true };
}

/** Scan a caption for URLs and return the first unsafe verdict (or safe). */
export function checkCaptionLinks(caption?: string | null): LinkVerdict {
  if (!caption) return { safe: true };
  const matches = caption.match(URL_REGEX);
  if (!matches) return { safe: true };
  for (const url of matches) {
    const verdict = classifyUrl(url);
    if (!verdict.safe) return verdict;
  }
  return { safe: true };
}
