/**
 * News source registry: how much weight a publisher carries, and which RSS/Atom feeds Atlas AI reads.
 *
 * Tiers (higher is more authoritative for ranking; never proof that a story is true):
 *   official   primary sources: company newsrooms, government agencies, international organizations
 *   wire       established international news organizations
 *   specialist reputable specialist publications (technology, security, science, space)
 *   regional   credible national and regional news organizations
 *   social     public social media posts (developing information, never confirmation on their own)
 *   unknown    anything else: usable, but ranked lowest and never the only support for a claim
 *
 * Feeds were checked live on 2026-11-09 (status, item count, first date). Feeds that answered 403,
 * 404 or returned no entries are kept here as disabled with the reason, so an administrator can see
 * why and switch them on if the publisher fixes them. Administrators can add, disable or re-enable
 * feeds in Settings (config/newsFeeds); this list is the default.
 */
import type { Region, Topic } from './freshness.js';

export type Tier = 'official' | 'wire' | 'specialist' | 'regional' | 'social' | 'unknown';
export const TIER_WEIGHT: Record<Tier, number> = { official: 1, wire: 0.9, specialist: 0.8, regional: 0.75, unknown: 0.35, social: 0.25 };
export const TIER_LABEL: Record<Tier, string> = {
  official: 'Official source',
  wire: 'International news organization',
  specialist: 'Specialist publication',
  regional: 'Regional news organization',
  social: 'Social media post (unconfirmed)',
  unknown: 'Other website',
};

/** Domain suffix -> tier. Matched against the hostname and its parent domains. */
const DOMAIN_TIERS: Record<string, Tier> = {
  // official: companies, governments, international organizations
  'openai.com': 'official', 'blog.google': 'official', 'googleblog.com': 'official', 'deepmind.google': 'official', 'microsoft.com': 'official',
  'nvidia.com': 'official', 'nvidianews.nvidia.com': 'official', 'apple.com': 'official', 'about.fb.com': 'official', 'meta.com': 'official',
  'cloudflare.com': 'official', 'anthropic.com': 'official', 'aws.amazon.com': 'official', 'aboutamazon.com': 'official', 'x.ai': 'official',
  'nasa.gov': 'official', 'esa.int': 'official', 'cisa.gov': 'official', 'ncsc.gov.uk': 'official', 'who.int': 'official', 'un.org': 'official',
  'news.un.org': 'official', 'worldbank.org': 'official', 'imf.org': 'official', 'au.int': 'official', 'ecowas.int': 'official', 'europa.eu': 'official',
  'gov.gh': 'official', 'presidency.gov.gh': 'official', 'mofep.gov.gh': 'official', 'bog.gov.gh': 'official', 'whitehouse.gov': 'official', 'gov.uk': 'official',
  'spacex.com': 'official', 'isro.gov.in': 'official',
  // international news organizations
  'reuters.com': 'wire', 'apnews.com': 'wire', 'bbc.com': 'wire', 'bbc.co.uk': 'wire', 'aljazeera.com': 'wire', 'theguardian.com': 'wire',
  'nytimes.com': 'wire', 'washingtonpost.com': 'wire', 'ft.com': 'wire', 'bloomberg.com': 'wire', 'wsj.com': 'wire', 'economist.com': 'wire',
  'npr.org': 'wire', 'dw.com': 'wire', 'france24.com': 'wire', 'afp.com': 'wire', 'cnn.com': 'wire', 'cnbc.com': 'wire', 'abc.net.au': 'wire',
  'scmp.com': 'wire', 'nhk.or.jp': 'wire', 'aa.com.tr': 'wire', 'euronews.com': 'wire', 'politico.com': 'wire', 'axios.com': 'wire',
  'skynews.com': 'wire', 'news.sky.com': 'wire', 'nbcnews.com': 'wire', 'cbsnews.com': 'wire', 'abcnews.go.com': 'wire', 'usnews.com': 'wire',
  // specialist publications
  'techcrunch.com': 'specialist', 'theverge.com': 'specialist', 'arstechnica.com': 'specialist', 'wired.com': 'specialist',
  'technologyreview.com': 'specialist', 'engadget.com': 'specialist', 'zdnet.com': 'specialist', 'theregister.com': 'specialist',
  'venturebeat.com': 'specialist', 'tomshardware.com': 'specialist', '9to5mac.com': 'specialist', '9to5google.com': 'specialist',
  'bleepingcomputer.com': 'specialist', 'thehackernews.com': 'specialist', 'krebsonsecurity.com': 'specialist', 'securityweek.com': 'specialist',
  'darkreading.com': 'specialist', 'therecord.media': 'specialist', 'space.com': 'specialist', 'spacenews.com': 'specialist',
  'nature.com': 'specialist', 'science.org': 'specialist', 'newscientist.com': 'specialist', 'scientificamerican.com': 'specialist',
  'semafor.com': 'specialist', 'restofworld.org': 'specialist', 'techcabal.com': 'specialist', 'theinformation.com': 'specialist',
  // regional news organizations
  'myjoyonline.com': 'regional', 'graphic.com.gh': 'regional', '3news.com': 'regional', 'citinewsroom.com': 'regional', 'ghanaweb.com': 'regional',
  'gna.org.gh': 'regional', 'modernghana.com': 'regional', 'pulse.com.gh': 'regional', 'myjoyonline.co': 'regional', 'graphic.com': 'regional',
  'allafrica.com': 'regional', 'news24.com': 'regional', 'premiumtimesng.com': 'regional', 'punchng.com': 'regional', 'thehindu.com': 'regional',
  'mercopress.com': 'regional', 'en.mercopress.com': 'regional', 'japantimes.co.jp': 'regional', 'straitstimes.com': 'regional', 'thenationalnews.com': 'regional',
  'channelnewsasia.com': 'regional', 'timesofindia.indiatimes.com': 'regional', 'hindustantimes.com': 'regional', 'theeastafrican.co.ke': 'regional',
  'nation.africa': 'regional', 'dailymaverick.co.za': 'regional', 'smh.com.au': 'regional', 'rnz.co.nz': 'regional',
  // social media
  'x.com': 'social', 'twitter.com': 'social', 'facebook.com': 'social', 'instagram.com': 'social', 'threads.net': 'social', 'linkedin.com': 'social',
  'reddit.com': 'social', 'youtube.com': 'social', 'tiktok.com': 'social', 'bsky.app': 'social', 'mastodon.social': 'social', 'medium.com': 'social',
};

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Credibility tier for a URL, matching the host and its parent domains; *.gov and *.gov.xx are official. */
export function tierOf(url: string, extra: Record<string, Tier> = {}): Tier {
  const host = hostname(url);
  if (!host) return 'unknown';
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    const t = extra[d] ?? DOMAIN_TIERS[d];
    if (t) return t;
  }
  if (/(^|\.)gov(\.[a-z]{2})?$/.test(host) || /(^|\.)gob\.[a-z]{2}$/.test(host) || /(^|\.)int$/.test(host)) return 'official';
  return 'unknown';
}

export interface FeedDef {
  id: string;
  name: string;
  url: string;
  /** publisher domain (credibility) */
  domain: string;
  tier: Tier;
  topics: Topic[];
  /** region ids the feed covers ('world' = international) */
  regions: string[];
  /** official newsroom of these organizations */
  entities?: string[];
  /** disabled feeds are not read; the reason is shown to administrators */
  disabled?: string | null;
}

const f = (id: string, name: string, url: string, domain: string, tier: Tier, topics: Topic[], regions: string[], extra: Partial<FeedDef> = {}): FeedDef => ({
  id, name, url, domain, tier, topics, regions, ...extra,
});

export const DEFAULT_FEEDS: FeedDef[] = [
  // international
  f('bbc_world', 'BBC News: World', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'bbc.co.uk', 'wire', ['general', 'politics'], ['world', 'europe', 'uk']),
  f('bbc_tech', 'BBC News: Technology', 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'bbc.co.uk', 'wire', ['tech', 'ai', 'security'], ['world']),
  f('bbc_africa', 'BBC News: Africa', 'https://feeds.bbci.co.uk/news/world/africa/rss.xml', 'bbc.co.uk', 'wire', ['general', 'politics'], ['africa', 'west_africa', 'ghana', 'nigeria']),
  f('bbc_science', 'BBC News: Science', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'bbc.co.uk', 'wire', ['science', 'space', 'health'], ['world']),
  f('aljazeera', 'Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'aljazeera.com', 'wire', ['general', 'politics'], ['world', 'middle_east', 'africa', 'asia']),
  f('guardian_world', 'The Guardian: World', 'https://www.theguardian.com/world/rss', 'theguardian.com', 'wire', ['general', 'politics'], ['world', 'europe']),
  f('guardian_tech', 'The Guardian: Technology', 'https://www.theguardian.com/uk/technology/rss', 'theguardian.com', 'wire', ['tech', 'ai'], ['world']),
  f('npr', 'NPR News', 'https://feeds.npr.org/1001/rss.xml', 'npr.org', 'wire', ['general', 'politics'], ['usa', 'north_america', 'world']),
  f('dw', 'DW', 'https://rss.dw.com/rdf/rss-en-all', 'dw.com', 'wire', ['general', 'politics', 'business'], ['world', 'europe', 'africa']),
  f('france24', 'France 24', 'https://www.france24.com/en/rss', 'france24.com', 'wire', ['general', 'politics'], ['world', 'europe', 'africa']),
  f('un_news', 'UN News', 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 'news.un.org', 'official', ['general', 'politics', 'health'], ['world']),
  f('who', 'World Health Organization', 'https://www.who.int/rss-feeds/news-english.xml', 'who.int', 'official', ['health'], ['world'], { entities: ['who'] }),
  f('scmp', 'South China Morning Post', 'https://www.scmp.com/rss/91/feed', 'scmp.com', 'wire', ['general', 'politics', 'business'], ['asia']),
  f('thehindu', 'The Hindu: International', 'https://www.thehindu.com/news/international/feeder/default.rss', 'thehindu.com', 'regional', ['general', 'politics'], ['asia', 'world']),
  f('abc_au', 'ABC News (Australia)', 'https://www.abc.net.au/news/feed/2942460/rss.xml', 'abc.net.au', 'wire', ['general'], ['oceania']),
  f('mercopress', 'MercoPress', 'https://en.mercopress.com/rss', 'en.mercopress.com', 'regional', ['general', 'politics', 'business'], ['south_america']),
  // Africa and Ghana
  f('allafrica', 'AllAfrica', 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf', 'allafrica.com', 'regional', ['general', 'politics', 'business'], ['africa', 'west_africa', 'ghana', 'nigeria']),
  f('myjoyonline', 'MyJoyOnline', 'https://www.myjoyonline.com/feed/', 'myjoyonline.com', 'regional', ['general', 'politics', 'business', 'sports', 'tech'], ['ghana', 'west_africa']),
  f('graphic', 'Graphic Online', 'https://www.graphic.com.gh/news.feed?type=rss', 'graphic.com.gh', 'regional', ['general', 'politics', 'business'], ['ghana', 'west_africa']),
  f('threenews', '3News', 'https://3news.com/feed/', '3news.com', 'regional', ['general', 'politics', 'business', 'sports'], ['ghana', 'west_africa']),
  f('citinewsroom', 'Citi Newsroom', 'https://citinewsroom.com/feed/', 'citinewsroom.com', 'regional', ['general', 'politics'], ['ghana'], { disabled: 'Returned no entries when checked (2026-11-09).' }),
  f('ghanaweb', 'GhanaWeb', 'https://www.ghanaweb.com/GhanaHomePage/NewsArchive/rss.xml', 'ghanaweb.com', 'regional', ['general'], ['ghana'], { disabled: 'Returned no entries when checked (2026-11-09).' }),
  f('gna', 'Ghana News Agency', 'https://gna.org.gh/feed/', 'gna.org.gh', 'regional', ['general'], ['ghana'], { disabled: 'Returned no entries when checked (2026-11-09).' }),
  f('modernghana', 'Modern Ghana', 'https://www.modernghana.com/rssfeed/news.xml', 'modernghana.com', 'regional', ['general'], ['ghana'], { disabled: 'Answered 403 (blocked) when checked (2026-11-09).' }),
  f('news24', 'News24', 'https://feeds.news24.com/articles/news24/TopStories/rss', 'news24.com', 'regional', ['general'], ['africa'], { disabled: 'Answered 403 (blocked) when checked (2026-11-09).' }),
  // technology and AI
  f('techcrunch', 'TechCrunch', 'https://techcrunch.com/feed/', 'techcrunch.com', 'specialist', ['tech', 'ai', 'business'], ['world']),
  f('verge', 'The Verge', 'https://www.theverge.com/rss/index.xml', 'theverge.com', 'specialist', ['tech'], ['world']),
  f('verge_ai', 'The Verge: AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'theverge.com', 'specialist', ['ai'], ['world']),
  f('ars', 'Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'arstechnica.com', 'specialist', ['tech', 'science', 'security', 'space'], ['world']),
  f('wired', 'Wired', 'https://www.wired.com/feed/rss', 'wired.com', 'specialist', ['tech', 'ai', 'security', 'science'], ['world']),
  f('mittr', 'MIT Technology Review', 'https://www.technologyreview.com/feed/', 'technologyreview.com', 'specialist', ['tech', 'ai', 'science'], ['world']),
  f('mittr_ai', 'MIT Technology Review: AI', 'https://www.technologyreview.com/topic/artificial-intelligence/feed', 'technologyreview.com', 'specialist', ['ai'], ['world']),
  // cybersecurity
  f('bleeping', 'BleepingComputer', 'https://www.bleepingcomputer.com/feed/', 'bleepingcomputer.com', 'specialist', ['security'], ['world']),
  f('thehackernews', 'The Hacker News', 'https://feeds.feedburner.com/TheHackersNews', 'thehackernews.com', 'specialist', ['security'], ['world']),
  f('krebs', 'Krebs on Security', 'https://krebsonsecurity.com/feed/', 'krebsonsecurity.com', 'specialist', ['security'], ['world']),
  f('securityweek', 'SecurityWeek', 'https://www.securityweek.com/feed/', 'securityweek.com', 'specialist', ['security'], ['world']),
  f('cisa', 'CISA advisories', 'https://www.cisa.gov/cybersecurity-advisories/all.xml', 'cisa.gov', 'official', ['security'], ['usa', 'world'], { entities: ['cisa'] }),
  // space
  f('nasa', 'NASA news releases', 'https://www.nasa.gov/news-release/feed/', 'nasa.gov', 'official', ['space', 'science'], ['world', 'usa'], { entities: ['nasa'] }),
  f('spacecom', 'Space.com', 'https://www.space.com/feeds/all', 'space.com', 'specialist', ['space', 'science'], ['world']),
  f('spacenews', 'SpaceNews', 'https://spacenews.com/feed/', 'spacenews.com', 'specialist', ['space'], ['world']),
  f('esa', 'ESA space news', 'https://www.esa.int/rssfeed/Our_Activities/Space_News', 'esa.int', 'official', ['space'], ['europe', 'world'], { disabled: 'Answered 404 when checked (2026-11-09).' }),
  // official newsrooms
  f('openai', 'OpenAI news', 'https://openai.com/news/rss.xml', 'openai.com', 'official', ['ai'], ['world'], { entities: ['openai'] }),
  f('google_blog', 'Google: The Keyword', 'https://blog.google/rss/', 'blog.google', 'official', ['tech', 'ai'], ['world'], { entities: ['google'] }),
  f('deepmind', 'Google DeepMind blog', 'https://deepmind.google/blog/rss.xml', 'deepmind.google', 'official', ['ai'], ['world'], { entities: ['deepmind', 'google'] }),
  f('microsoft', 'Microsoft On the Issues / news', 'https://blogs.microsoft.com/feed/', 'microsoft.com', 'official', ['tech', 'ai'], ['world'], { entities: ['microsoft'] }),
  f('nvidia', 'NVIDIA newsroom', 'https://nvidianews.nvidia.com/releases.xml', 'nvidianews.nvidia.com', 'official', ['tech', 'ai'], ['world'], { entities: ['nvidia'] }),
  f('nvidia_blog', 'NVIDIA blog', 'https://blogs.nvidia.com/feed/', 'nvidia.com', 'official', ['tech', 'ai'], ['world'], { entities: ['nvidia'] }),
  f('cloudflare', 'Cloudflare blog', 'https://blog.cloudflare.com/rss/', 'cloudflare.com', 'official', ['tech', 'security'], ['world'], { entities: ['cloudflare'] }),
  f('apple', 'Apple Newsroom', 'https://www.apple.com/newsroom/rss-feed.rss', 'apple.com', 'official', ['tech'], ['world'], { entities: ['apple'] }),
  f('meta', 'Meta newsroom', 'https://about.fb.com/feed/', 'about.fb.com', 'official', ['tech', 'ai'], ['world'], { entities: ['meta'] }),
  f('anthropic', 'Anthropic news', 'https://www.anthropic.com/news/rss.xml', 'anthropic.com', 'official', ['ai'], ['world'], { entities: ['anthropic'], disabled: 'No public RSS feed (404 when checked 2026-11-09).' }),
];

/**
 * Feeds worth reading for a request: official newsrooms of the organizations named, plus feeds that
 * match the topic and region. Capped so one question never fans out to dozens of requests.
 */
export function feedsFor(req: { topics: Topic[]; entities: string[]; region: Region; worldwide: boolean }, feeds: FeedDef[], max = 8): FeedDef[] {
  const live = feeds.filter((x) => !x.disabled);
  const picked: FeedDef[] = [];
  const add = (x: FeedDef) => {
    if (!picked.some((p) => p.id === x.id)) picked.push(x);
  };
  for (const e of req.entities) live.filter((x) => x.entities?.includes(e)).forEach(add);
  const regional = req.region.id !== 'world';
  const topicHit = (x: FeedDef) => req.topics.some((t) => x.topics.includes(t));
  const regionHit = (x: FeedDef) => x.regions.includes(req.region.id) || (req.region.id === 'ghana' && x.regions.includes('west_africa'));
  if (regional) {
    // the country's own outlets first, then international coverage of the region
    live.filter((x) => regionHit(x) && (topicHit(x) || req.topics.includes('general') || x.topics.includes('general'))).forEach(add);
  }
  const specific: Topic[] = req.topics.filter((t) => t !== 'general');
  if (specific.length) {
    // dedicated feeds (every topic they cover was asked for) before broad ones; an organization's own
    // newsroom joins only when it is dedicated to the topic (e.g. CISA for security)
    const share = (x: FeedDef) => x.topics.filter((t) => specific.includes(t)).length / x.topics.length;
    live
      .filter((x) => x.regions.includes('world') && share(x) > 0 && (!x.entities?.length || share(x) === 1))
      .map((x, i) => ({ x, i, s: share(x) + (x.topics[0] === specific[0] ? 0.5 : 0) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .forEach(({ x }) => add(x));
  }
  if (!specific.length || req.worldwide) live.filter((x) => x.regions.includes('world') && x.topics.includes('general')).forEach(add);
  return picked.slice(0, max);
}
