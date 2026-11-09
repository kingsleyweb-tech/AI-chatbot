/**
 * Understands a news request: is it about current events, how fresh must the results be, what is
 * the topic, and which part of the world. Deterministic (no model call, no credits).
 *
 * Freshness windows are defaults, not hard walls: each has a wider fallback that is used only when
 * too few trustworthy articles fall inside the preferred window, and the answer then says so.
 */

export type WindowKind = 'breaking' | 'today' | 'yesterday' | 'latest' | 'week' | 'recent' | 'month' | 'year' | 'default';

export interface FreshnessWindow {
  kind: WindowKind;
  /** human wording for the answer, e.g. "the last 24 hours" */
  label: string;
  /** articles published at or after this time are inside the preferred window */
  since: number;
  /** optional upper bound (yesterday) */
  until?: number;
  /** wider window used only when too few articles fall inside the preferred one */
  expandSince: number | null;
  expandLabel: string | null;
  /** coarse provider filter covering the wider window: SerpAPI tbs qdr:* / Tavily time_range */
  providerRange: 'hour' | 'day' | 'week' | 'month' | 'year';
}

export type Topic = 'ai' | 'tech' | 'security' | 'space' | 'science' | 'politics' | 'business' | 'health' | 'sports' | 'general';

export interface Region {
  id: string;
  label: string;
  /** Google country code for SerpAPI (gl); absent = international */
  gl?: string;
  /** Tavily country name (general topic only) */
  country?: string;
}

export interface NewsRequest {
  window: FreshnessWindow;
  topics: Topic[];
  /** search keywords without time words, filler or the region */
  keywords: string;
  /** organizations mentioned that publish official newsrooms (openai, nvidia, ...) */
  entities: string[];
  region: Region;
  /** the user asked for worldwide coverage explicitly */
  worldwide: boolean;
}

const H = 3_600_000;
const D = 24 * H;

const startOfUtcDay = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Words that make a question about current events (with a topic). */
const NEWS_WORDS = /\b(news|headlines?|breaking|announce(?:d|ment|ments)?|press releases?|happen(?:ed|ing)|developments?|updates?|stories|coverage|current events|current affairs|global affairs|world affairs)\b/i;
const RECENT_WORDS = /\b(latest|newest|current(?:ly)?|today|tonight|this (?:morning|afternoon|evening|week|month|year)|yesterday|right now|at the moment|recent(?:ly)?|past (?:few )?(?:hours?|days?|weeks?)|last (?:24|48|72) hours|this hour|just (?:announced|released|launched|happened))\b/i;
/** Not news: live data (weather, prices, scores) and software versions go through the normal search path. */
const NOT_NEWS = /\b(weather|forecast|exchange rate|stock price|share price|price of|scores?|fixtures|standings|latest version|current version|newest version|stable release|npm|pip install|changelog)\b/i;
/** Explicitly historical: no freshness requirement. */
const HISTORICAL = /\b(history of|historical|in (?:the )?(?:19|20)\d{2}s?\b|back in|years ago|timeline of|origins? of|was founded)\b/i;

export function windowFor(text: string, now = Date.now()): FreshnessWindow {
  const t = text.toLowerCase();
  const day = startOfUtcDay(now);
  const mk = (kind: WindowKind, label: string, since: number, expandSince: number | null, expandLabel: string | null, providerRange: FreshnessWindow['providerRange'], until?: number): FreshnessWindow => ({
    kind,
    label,
    since,
    ...(until ? { until } : {}),
    expandSince,
    expandLabel,
    providerRange,
  });
  if (/\b(breaking|right now|this hour|just (?:announced|released|launched|happened)|live updates?)\b/.test(t))
    return mk('breaking', 'the last few hours', now - 6 * H, now - 24 * H, 'the last 24 hours', 'day');
  if (/\byesterday\b/.test(t)) return mk('yesterday', 'yesterday (UTC)', day - D, day - 2 * D, 'the last two days', 'week', day);
  if (/\b(today|tonight|this (?:morning|afternoon|evening))\b/.test(t)) {
    // early in the UTC day there is little "today" yet: never look back less than 12 hours
    return mk('today', 'today', Math.min(day, now - 12 * H), now - 48 * H, 'the last 48 hours', 'week');
  }
  if (/\b(this|past|last) week\b|\b(last|past) 7 days\b|\bweekly\b/.test(t)) return mk('week', 'the last 7 days', now - 7 * D, now - 14 * D, 'the last 14 days', 'month');
  if (/\bthis month\b|\b(last|past) (?:30 days|month)\b/.test(t)) {
    const d = new Date(now);
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return mk('month', 'this month', Math.min(month, now - 7 * D), now - 31 * D, 'the last 31 days', 'month');
  }
  if (/\bthis year\b/.test(t)) {
    const year = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    return mk('year', 'this year', Math.min(year, now - 31 * D), null, null, 'year');
  }
  if (/\b(recent(?:ly)? developments?|recent(?:ly)?|past few weeks|lately)\b/.test(t) && !/\blatest\b/.test(t))
    return mk('recent', 'the last 30 days', now - 30 * D, now - 60 * D, 'the last 60 days', 'month');
  if (/\b(latest|newest|current(?:ly)?|happening|at the moment|news|headlines?|updates?|developments?)\b/.test(t))
    return mk('latest', 'the last 24 hours', now - 24 * H, now - 72 * H, 'the last 72 hours', 'week');
  return mk('default', 'the last 3 days', now - 3 * D, now - 7 * D, 'the last 7 days', 'week');
}

const TOPIC_RULES: [Topic, RegExp][] = [
  ['ai', /\b(ai|a\.i\.|artificial intelligence|machine learning|deep learning|llms?|large language models?|generative|chatgpt|openai|gpt-?\d|gemini|claude|anthropic|deepmind|copilot|mistral|llama|hugging ?face)\b/i],
  ['security', /\b(cyber ?security|cyber|infosec|security|hack(?:s|ers?|ed|ing)?|breach(?:es)?|ransomware|malware|vulnerabilit(?:y|ies)|zero[- ]day|cve|phishing|data leak)\b/i],
  ['space', /\b(space|nasa|spacex|esa|isro|rocket|rocket launch(?:es)?|orbit(?:al)?|spacecraft|space station|iss|satellite|moon|lunar|mars|astronaut|astronomy|telescope|starship)\b/i],
  ['tech', /\b(tech|technology|technologies|gadgets?|software|hardware|startups?|silicon valley|smartphones?|chips?|semiconductors?|apple|google|microsoft|meta|amazon|nvidia|cloudflare|samsung|tesla|big tech)\b/i],
  ['science', /\b(science|scientists?|research(?:ers)?|study|physics|biology|climate|environment)\b/i],
  ['politics', /\b(politic(?:s|al)|elections?|government|parliament|president|prime minister|diplomac(?:y|tic)|geopolitic(?:s|al)|global affairs|world affairs|foreign policy|war|conflict|sanctions|summit|united nations)\b/i],
  ['business', /\b(business|econom(?:y|ic|ics)|markets?|finance|financial|stocks?|trade|inflation|central bank|earnings|ipo|cedi|gdp)\b/i],
  ['health', /\b(health|medical|medicine|disease|outbreak|pandemic|vaccines?|who|hospital)\b/i],
  ['sports', /\b(sports?|football|soccer|basketball|athletics|olympics|premier league|black stars|afcon)\b/i],
];

/** Organizations whose official newsroom feeds Atlas AI reads. */
const ENTITY_RULES: [string, RegExp][] = [
  ['openai', /\b(openai|chatgpt|gpt-?\d|sora)\b/i],
  ['google', /\b(google|alphabet|gemini|android|youtube)\b/i],
  ['deepmind', /\b(deepmind)\b/i],
  ['microsoft', /\b(microsoft|windows|azure|copilot|xbox)\b/i],
  ['nvidia', /\b(nvidia|geforce|cuda)\b/i],
  ['apple', /\b(apple|iphone|ipad|macos|ios|vision pro)\b/i],
  ['meta', /\b(meta|facebook|instagram|whatsapp|llama)\b/i],
  ['cloudflare', /\b(cloudflare)\b/i],
  ['anthropic', /\b(anthropic|claude)\b/i],
  ['nasa', /\b(nasa|artemis)\b/i],
  ['cisa', /\b(cisa)\b/i],
  ['who', /\b(world health organi[sz]ation|\bwho\b(?= (?:says|warns|reports|declares|announces)))\b/i],
];

const REGIONS: { id: string; label: string; re: RegExp; gl?: string; country?: string }[] = [
  { id: 'ghana', label: 'Ghana', re: /\b(ghana|ghanaian|accra|kumasi|tamale|takoradi|cape coast)\b/i, gl: 'gh', country: 'ghana' },
  { id: 'nigeria', label: 'Nigeria', re: /\b(nigeria|nigerian|lagos|abuja)\b/i, gl: 'ng', country: 'nigeria' },
  { id: 'west_africa', label: 'West Africa', re: /\b(west africa|west african|ecowas)\b/i },
  { id: 'africa', label: 'Africa', re: /\b(africa|african)\b/i },
  { id: 'europe', label: 'Europe', re: /\b(europe|european|eu)\b/i },
  { id: 'uk', label: 'United Kingdom', re: /\b(uk|united kingdom|britain|british|england)\b/i, gl: 'uk', country: 'united kingdom' },
  { id: 'north_america', label: 'North America', re: /\b(north america|canada|canadian)\b/i },
  { id: 'usa', label: 'United States', re: /\b(usa|u\.s\.|united states|american|america)\b/i, gl: 'us', country: 'united states' },
  { id: 'south_america', label: 'South America', re: /\b(south america|latin america|brazil|argentina|chile|colombia|peru)\b/i },
  { id: 'middle_east', label: 'Middle East', re: /\b(middle east|gulf states|israel|iran|saudi|uae|qatar|gaza|lebanon|syria)\b/i },
  { id: 'asia', label: 'Asia', re: /\b(asia|asian|china|chinese|india|indian|japan|japanese|korea|korean|indonesia|southeast asia)\b/i },
  { id: 'oceania', label: 'Oceania', re: /\b(oceania|australia|australian|new zealand|pacific islands)\b/i, gl: 'au', country: 'australia' },
];
export const WORLDWIDE: Region = { id: 'world', label: 'worldwide' };

const FILLER = new Set(
  (
    'give me tell me show me what whats what\'s are is was were the a an of on in about for from to and or any some me us please can could you would ' +
    'latest newest current currently today tonight yesterday this that week month year morning evening right now recent recently lately breaking ' +
    'news headlines headline update updates development developments happening happened going stories story coverage new events affairs ' +
    'worldwide global globally world international around across all major top big key important biggest past last few hours days 24 48 72 hour day ' +
    'industry sector sectors area areas field fields ' +
    // how the user wants the answer, not what it is about
    'research researching investigate find look check search online web internet separate separately confirmed unconfirmed verified ' +
    'reports report reported reporting developing more less them it its they their these those not no brief briefly short shorter long longer ' +
    'detail details detailed in-depth depth deep dive full fully comprehensive overview summary summarise summarize explain explained analysis ' +
    'analyse analyze also both including include such as like with without how why which where when do does did has have had be been ' +
    'will should would i my we our want need know tell give provide list write paragraph paragraphs points bullet bullets format sources ' +
    'source cite citations between versus vs very much many well just only'
  ).split(/\s+/).filter(Boolean),
);

/** Keywords for the search engines: the subject without time words, filler or the region. */
export function newsKeywords(text: string, region: Region | null): string {
  // "this week's" -> "this week" (otherwise a stray "s" becomes a keyword)
  let t = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/['’]s\b/g, ' ');
  if (region && region.id !== 'world') {
    const r = REGIONS.find((x) => x.id === region.id);
    if (r) t = t.replace(new RegExp(r.re.source, 'gi'), ' ');
  }
  const words = t
    .replace(/[^\p{L}\p{N}\s.+#-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w && !FILLER.has(w));
  return words.join(' ').slice(0, 120).trim();
}

/**
 * The item is about one of these topics: the headline says so, or the summary does with at least
 * two different topic terms (one loose word such as "space" in a summary is not enough).
 */
export function matchesTopics(title: string, summary: string, topics: Topic[]): boolean {
  const rules = TOPIC_RULES.filter(([k]) => topics.includes(k));
  if (rules.some(([, re]) => re.test(title))) return true;
  const terms = new Set<string>();
  for (const [, re] of rules) for (const m of summary.matchAll(new RegExp(re.source, 'gi'))) terms.add(m[0].toLowerCase());
  return terms.size >= 2;
}

/** Larger regions that contain a region ("South Africa" is not Ghana, but Africa contains it). */
const PARENTS: Record<string, string[]> = { ghana: ['west_africa', 'africa'], nigeria: ['west_africa', 'africa'], west_africa: ['africa'], uk: ['europe'], usa: ['north_america'] };
/** Countries often in the news that the region list does not name. */
const OTHER_COUNTRIES = /\b(egypt|egyptian|south africa|kenya|kenyan|ethiopia|sudan|morocco|algeria|tunisia|libya|senegal|ivory coast|c[oô]te d'ivoire|burkina faso|togo|benin|mali|niger|cameroon|congo|uganda|tanzania|rwanda|zimbabwe|zambia|angola|mozambique|russia|russian|ukraine|ukrainian|france|french|germany|german|italy|spain|poland|krakow|turkey|pakistan|mexico|venezuela|cuba|white house|congress|senate|pentagon|house democrats?|house republicans?)\b/i;

/** The text mentions the region (country, demonym or a main city). */
export function matchesRegion(text: string, regionId: string): boolean {
  const r = REGIONS.find((x) => x.id === regionId);
  return r ? r.re.test(text) : true;
}

/** The text is plainly about somewhere else and not about the region. */
export function aboutElsewhere(text: string, regionId: string): boolean {
  if (regionId === 'world' || matchesRegion(text, regionId)) return false;
  const skip = new Set([regionId, ...(PARENTS[regionId] ?? [])]);
  const t = text.replace(/\bsouth africa/gi, (m) => (regionId === 'africa' ? m : 'SOUTHAFRICA'));
  if (/SOUTHAFRICA/.test(t)) return true;
  return REGIONS.some((r) => !skip.has(r.id) && r.re.test(t)) || OTHER_COUNTRIES.test(text);
}

/** null when the message is not a request for current news (the normal search path handles it). */
export function detectNews(text: string, now = Date.now()): NewsRequest | null {
  const t = text.trim();
  if (!t || t.length > 600) return null;
  if (NOT_NEWS.test(t)) return null;
  const news = NEWS_WORDS.test(t);
  const recent = RECENT_WORDS.test(t);
  if (!news && !recent) return null;
  // "what happened in 1957" or "history of ..." is not a freshness request
  if (HISTORICAL.test(t) && !recent) return null;
  // a bare "latest"/"current" question without anything newsy ("current time", "latest version") is not news
  if (!news && !/\b(happening|developments?|going on|situation|affairs)\b/i.test(t) && !TOPIC_RULES.some(([, re]) => re.test(t))) return null;

  const worldwide = /\b(worldwide|world ?wide|global(?:ly)?|international(?:ly)?|around the world|in the world|world news|across the world)\b/i.test(t);
  const found = REGIONS.find((r) => r.re.test(t));
  const region: Region = found ? { id: found.id, label: found.label, ...(found.gl ? { gl: found.gl } : {}), ...(found.country ? { country: found.country } : {}) } : WORLDWIDE;
  const topics = TOPIC_RULES.filter(([, re]) => re.test(t)).map(([k]) => k);
  // "AI" stories are tech stories too (feeds and credibility)
  if (topics.includes('ai') && !topics.includes('tech')) topics.push('tech');
  const entities = ENTITY_RULES.filter(([, re]) => re.test(t)).map(([k]) => k);
  return {
    window: windowFor(t, now),
    topics: topics.length ? topics : ['general'],
    keywords: newsKeywords(t, found ? region : null),
    entities,
    region,
    worldwide: worldwide || !found,
  };
}
