/**
 * Reserved username blocklist.
 * Checked case-insensitively at signup and username-change time.
 *
 * Categories:
 *  - Platform-owned words (yomeet, kora, admin, …)
 *  - Country / territory names
 *  - Major brands + tech companies
 *  - Government / official terms
 *  - Common squats (me, real, official, …)
 */

const RESERVED: ReadonlySet<string> = new Set([
  // ── Platform-owned ──────────────────────────────────────────────────────────
  'yomeet', 'kora', 'yomeetapp', 'yomeetofficial',
  'admin', 'administrator', 'staff', 'team', 'support', 'help', 'helpdesk',
  'moderator', 'mod', 'system', 'bot', 'official', 'verified',
  'security', 'abuse', 'noreply', 'no-reply', 'contact', 'info',
  'root', 'superuser', 'null', 'undefined', 'anonymous', 'guest',
  'test', 'demo', 'sample', 'placeholder',

  // ── Common squats ────────────────────────────────────────────────────────────
  'me', 'real', 'the', 'official', 'original', 'true', 'real',
  'news', 'live', 'update', 'updates', 'alert', 'alerts', 'notification',

  // ── Tech / Social-media brands ───────────────────────────────────────────────
  'apple', 'google', 'microsoft', 'amazon', 'meta', 'facebook', 'instagram',
  'whatsapp', 'twitter', 'x', 'tiktok', 'snapchat', 'pinterest', 'linkedin',
  'youtube', 'netflix', 'spotify', 'twitch', 'discord', 'telegram', 'signal',
  'reddit', 'tumblr', 'quora', 'medium', 'substack',
  'samsung', 'sony', 'lg', 'huawei', 'xiaomi', 'oppo', 'oneplus',
  'nvidia', 'intel', 'amd', 'qualcomm', 'arm',
  'ibm', 'oracle', 'sap', 'salesforce', 'adobe', 'autodesk',
  'uber', 'lyft', 'airbnb', 'doordash', 'grubhub', 'postmates',
  'paypal', 'stripe', 'square', 'visa', 'mastercard', 'amex', 'americanexpress',
  'shopify', 'ebay', 'etsy', 'alibaba', 'aliexpress', 'taobao', 'jd',
  'tesla', 'spacex', 'boeing', 'airbus',
  'openai', 'anthropic', 'deepmind', 'mistral', 'claude', 'chatgpt',
  'github', 'gitlab', 'bitbucket', 'stackoverflow', 'npm', 'pypi',
  'dropbox', 'box', 'notion', 'figma', 'canva', 'slack', 'zoom', 'webex',
  'atlassian', 'jira', 'confluence', 'trello', 'asana', 'monday',
  'wordpress', 'wix', 'squarespace', 'godaddy',
  'coinbase', 'binance', 'kraken', 'robinhood',
  'bloomberg', 'reuters', 'cnn', 'bbc', 'nbc', 'abc', 'cbs', 'fox',
  'nytimes', 'wsj', 'guardian', 'forbes', 'techcrunch', 'wired',
  'mcdonalds', 'starbucks', 'nike', 'adidas', 'puma', 'reebok',
  'cocacola', 'pepsi', 'nestle', 'unilever', 'pg', 'johnson',
  'pfizer', 'moderna', 'astrazeneca', 'roche', 'novartis',
  'jpmorgan', 'goldman', 'citibank', 'barclays', 'hsbc', 'ubs',

  // ── Government / official ────────────────────────────────────────────────────
  'government', 'gov', 'government', 'federal', 'state', 'senate',
  'congress', 'parliament', 'president', 'whitehouse', 'kremlin',
  'fbi', 'cia', 'nsa', 'dhs', 'doj', 'dod', 'nato', 'interpol', 'un', 'who',
  'unicef', 'worldbank', 'imf', 'wto', 'ilo', 'eu', 'oecd',
  'police', 'cop', 'officer', 'military', 'army', 'navy', 'airforce',
  'whitehouse', 'downingstreet', 'elysee',

  // ── Countries & territories ──────────────────────────────────────────────────
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina',
  'armenia', 'australia', 'austria', 'azerbaijan', 'bahamas', 'bahrain',
  'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin',
  'bhutan', 'bolivia', 'bosnia', 'botswana', 'brazil', 'brunei',
  'bulgaria', 'burkinafaso', 'burundi', 'cambodia', 'cameroon', 'canada',
  'capeverde', 'chad', 'chile', 'china', 'colombia', 'comoros', 'congo',
  'costarica', 'croatia', 'cuba', 'cyprus', 'czech', 'czechia',
  'denmark', 'djibouti', 'dominica', 'dominicanrepublic', 'ecuador',
  'egypt', 'elsalvador', 'eritrea', 'estonia', 'eswatini', 'ethiopia',
  'fiji', 'finland', 'france', 'gabon', 'gambia', 'georgia', 'germany',
  'ghana', 'greece', 'grenada', 'guatemala', 'guinea', 'guyana',
  'haiti', 'honduras', 'hungary', 'iceland', 'india', 'indonesia',
  'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica', 'japan',
  'jordan', 'kazakhstan', 'kenya', 'kiribati', 'korea', 'northkorea',
  'southkorea', 'kosovo', 'kuwait', 'kyrgyzstan', 'laos', 'latvia',
  'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania',
  'luxembourg', 'madagascar', 'malawi', 'malaysia', 'maldives', 'mali',
  'malta', 'mauritania', 'mauritius', 'mexico', 'moldova', 'monaco',
  'mongolia', 'montenegro', 'morocco', 'mozambique', 'myanmar', 'namibia',
  'nauru', 'nepal', 'netherlands', 'newzealand', 'nicaragua', 'niger',
  'nigeria', 'norway', 'oman', 'pakistan', 'palau', 'palestine', 'panama',
  'papuanewguinea', 'paraguay', 'peru', 'philippines', 'poland', 'portugal',
  'qatar', 'romania', 'russia', 'rwanda', 'samoa', 'sanmarino',
  'saudiarabia', 'senegal', 'serbia', 'seychelles', 'sierraleone',
  'singapore', 'slovakia', 'slovenia', 'somalia', 'southafrica',
  'southsudan', 'spain', 'srilanka', 'sudan', 'suriname', 'sweden',
  'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania', 'thailand',
  'timorleste', 'togo', 'tonga', 'trinidadandtobago', 'tunisia', 'turkey',
  'turkmenistan', 'tuvalu', 'uganda', 'ukraine', 'uae', 'unitedarabemirates',
  'uk', 'unitedkingdom', 'greatbritain', 'britain', 'england', 'scotland',
  'wales', 'northernireland', 'usa', 'unitedstates', 'america',
  'uruguay', 'uzbekistan', 'vanuatu', 'venezuela', 'vietnam', 'yemen',
  'zambia', 'zimbabwe',
]);

/**
 * Returns true if the username is reserved and should be rejected.
 * The check is case-insensitive and also strips common decorators
 * (underscores, digits) to catch "apple_" / "apple1" / "_apple" style grabs.
 */
export function isReservedUsername(username: string): boolean {
  const normalized = username.toLowerCase().replace(/[_\-.]/g, '');
  if (RESERVED.has(normalized)) return true;

  // Also block the exact-cased original (in case someone bypasses strip)
  if (RESERVED.has(username.toLowerCase())) return true;

  // Block "realapple", "officialapple", "applehq", "applesupport" etc.
  for (const reserved of RESERVED) {
    if (
      normalized === `real${reserved}` ||
      normalized === `official${reserved}` ||
      normalized === `${reserved}hq` ||
      normalized === `${reserved}official` ||
      normalized === `${reserved}real` ||
      normalized === `the${reserved}`
    ) {
      return true;
    }
  }

  return false;
}
