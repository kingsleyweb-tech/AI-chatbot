/**
 * News discovery: one reusable pipeline for "latest news" questions (chat, Deep Research, any news UI).
 *
 *  1. understand the request (freshness window, topic, region)                     freshness.ts
 *  2. ask SerpAPI (Google News tab, time-limited, sorted by date) and Tavily
 *     (news topic, time_range) in parallel, each through the search router so
 *     budgets, caching and failure tracking still apply                             ../search/router.ts
 *  3. read the matching publisher feeds and official newsrooms (free)              rss.ts, sources.ts
 *  4. normalise every article and validate its publication date                    dates.ts
 *  5. drop articles outside the window (widening it once, openly, when too few
 *     remain), merge duplicates and syndicated copies into stories
 *  6. rank stories by recency, relevance, source credibility and independent support
 *  7. hand the model a structured brief (never raw search output)
 *
 * Nothing here invents a date, a source or a headline: an article whose date cannot be
 * established is counted and excluded from the current list.
 */
import type { SearchLimits, Source } from '../shared/types.js';
import type { SearchService } from '../search/router.js';
import type { SearchStore } from '../search/store.js';
import type { SearchProviderId, SearchResult } from '../search/types.js';
import { checkDate, parseDate, type DateCheck } from './dates.js';
import { aboutElsewhere, matchesRegion, matchesTopics, type NewsRequest, type Topic } from './freshness.js';
import { readFeed, type FeedResult } from './rss.js';
import { feedsFor, hostname, tierOf, TIER_LABEL, TIER_WEIGHT, type FeedDef, type Tier } from './sources.js';

export type NewsOrigin = SearchProviderId | 'rss';

export interface NewsItem {
  title: string;
  url: string;
  canonical: string;
  source: string;
  domain: string;
  tier: Tier;
  snippet: string;
  date: DateCheck;
  origin: NewsOrigin;
  /** provider's own date wording, when there was one */
  dateText?: string;
  relevance: number;
  /** id of the publisher feed it came from */
  feed?: string;
}

export interface Story {
  lead: NewsItem;
  supporting: NewsItem[];
  /** publishers that reported it without copying the same text (syndication counts once) */
  independent: number;
  score: number;
  /** official source, or two or more independent credible sources */
  confirmation: 'official' | 'multiple' | 'single' | 'unconfirmed';
}

export interface ProviderReport {
  id: NewsOrigin;
  status: 'ok' | 'empty' | 'failed' | 'skipped';
  articles: number;
  cached?: boolean;
  reason?: string;
  ms?: number;
}

export interface NewsStats {
  discovered: number;
  inWindow: number;
  rejectedOld: number;
  undated: number;
  redated: number;
  duplicates: number;
  irrelevant: number;
  feedsRead: number;
  feedsFailed: number;
}

export interface NewsResult {
  request: NewsRequest;
  retrievedAt: number;
  stories: Story[];
  background: NewsItem[];
  /** the window actually used (the preferred one, or the wider fallback) */
  windowLabel: string;
  expanded: boolean;
  providers: ProviderReport[];
  feeds: FeedResult[];
  stats: NewsStats;
  notices: string[];
  /** set when nothing at all could be retrieved */
  failure: string | null;
}

/* ------------------------------ text helpers ------------------------------ */

const STOP = new Set(
  'the a an and or of to in on for with at by from as is are was were be been it its this that these those after before over under into about than then new says said will can could would has have had not but more most just how why what who when where which amid via up out off top'.split(
    ' ',
  ),
);
/** generic topic words: a feed chosen for the topic already matches them */
const GENERIC = new Set(
  ('technology tech ai artificial intelligence cybersecurity cyber security space exploration politics political global science business economy health sports world news developments industry ' +
    'economic economics finance financial government governance policy policies education educational schools universities sector sectors').split(' '),
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Headline without the trailing " - Publisher" / " | Publisher" that aggregators append. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '').trim();
}

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ocid|cmpid|ref|src|guccounter|taid|smid|ito)/i.test(k)) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/amp\/?$/, '/').replace(/\.amp$/, '').replace(/\/+$/, '') || '/';
    return `${u.hostname}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.8 && Math.min(A.size, B.size) >= 4 ? Math.max(inter / (A.size + B.size - inter), 0.6) : inter / (A.size + B.size - inter);
}

/** Share of the request's specific keywords that an article mentions (1 when the request has none). */
export function relevanceOf(text: string, keywords: string[]): number {
  if (!keywords.length) return 1;
  const words = new Set(tokens(text));
  const hit = keywords.filter((k) => words.has(k) || [...words].some((w) => w.length > 4 && k.length > 4 && (w.startsWith(k) || k.startsWith(w)))).length;
  return hit / keywords.length;
}

/* ------------------------------ normalisation ------------------------------ */

function fromSearch(r: SearchResult, origin: SearchProviderId, keywords: string[], now: number): NewsItem {
  const reported = r.publishedDate ? parseDate(r.publishedDate, now) : null;
  const title = cleanTitle(r.title);
  return {
    title,
    url: r.url,
    canonical: canonicalUrl(r.url),
    source: r.site || hostname(r.url),
    domain: hostname(r.url),
    tier: tierOf(r.url),
    snippet: (r.content && r.content.length > r.snippet.length ? r.content : r.snippet).replace(/\s+/g, ' ').slice(0, 500),
    date: checkDate({ url: r.url, reported }, now),
    origin,
    ...(r.dateText ? { dateText: r.dateText } : {}),
    // the provider matched the query already; keywords refine it
    relevance: 0.5 + 0.5 * relevanceOf(`${title} ${r.snippet}`, keywords),
  };
}

function fromFeed(item: FeedResult['items'][number], feed: FeedDef, keywords: string[], entityFeed: boolean, now: number): NewsItem {
  const title = cleanTitle(item.title);
  const rel = relevanceOf(`${title} ${item.summary}`, keywords);
  return {
    title,
    url: item.url,
    canonical: canonicalUrl(item.url),
    source: feed.name,
    domain: hostname(item.url) || feed.domain,
    // the feed's publisher decides the tier (an official newsroom linking to its own site)
    tier: tierOf(item.url) === 'unknown' ? feed.tier : tierOf(item.url),
    snippet: item.summary,
    date: checkDate({ url: item.url, feedPublished: item.published, updated: item.updated }, now),
    origin: 'rss',
    feed: feed.id,
    // an organization's own newsroom is relevant to a question about that organization
    relevance: entityFeed ? Math.max(0.75, rel) : rel,
  };
}

/* ------------------------------ grouping and ranking ------------------------------ */

function group(items: NewsItem[]): { stories: NewsItem[][]; duplicates: number } {
  const byUrl = new Map<string, NewsItem>();
  let duplicates = 0;
  for (const it of items) {
    const prev = byUrl.get(it.canonical);
    if (prev) {
      duplicates++;
      // keep the copy with the most reliable date and the better source
      if ((it.date.status === 'confirmed' && prev.date.status !== 'confirmed') || TIER_WEIGHT[it.tier] > TIER_WEIGHT[prev.tier]) byUrl.set(it.canonical, it);
      continue;
    }
    byUrl.set(it.canonical, it);
  }
  const stories: { items: NewsItem[]; toks: string[] }[] = [];
  for (const it of byUrl.values()) {
    const toks = tokens(it.title);
    const match = stories.find((s) => similarity(s.toks, toks) >= 0.45);
    if (match) {
      match.items.push(it);
      duplicates++;
    } else stories.push({ items: [it], toks });
  }
  return { stories: stories.map((s) => s.items), duplicates };
}

function independentCount(items: NewsItem[]): number {
  // syndicated copies (same headline on several sites) and several pages of one publisher count once
  const seen: { domain: string; toks: string[] }[] = [];
  for (const it of items) {
    const toks = tokens(it.title);
    if (seen.some((s) => s.domain === it.domain || similarity(s.toks, toks) >= 0.9)) continue;
    seen.push({ domain: it.domain, toks });
  }
  return seen.length;
}

function rankStory(items: NewsItem[], since: number, now: number): Story {
  const sorted = [...items].sort(
    (a, b) =>
      TIER_WEIGHT[b.tier] - TIER_WEIGHT[a.tier] ||
      // the earliest credible report is most likely the original
      (a.date.published ?? Infinity) - (b.date.published ?? Infinity),
  );
  const lead = sorted[0];
  const independent = independentCount(sorted.filter((x) => x.tier !== 'social'));
  const newest = Math.max(...items.map((x) => x.date.published ?? 0));
  const span = Math.max(now - since, 3_600_000);
  const recency = Math.max(0, Math.min(1, 1 - (now - newest) / span));
  const relevance = Math.max(...items.map((x) => x.relevance));
  const tier = TIER_WEIGHT[lead.tier];
  const corroboration = Math.min(1, (independent - 1) / 3);
  const score = 0.35 * recency + 0.3 * relevance + 0.25 * tier + 0.1 * corroboration;
  const confirmation: Story['confirmation'] =
    items.some((x) => x.tier === 'official') ? 'official' : independent >= 2 && items.some((x) => x.tier === 'wire' || x.tier === 'specialist' || x.tier === 'regional') ? 'multiple' : lead.tier === 'social' || lead.tier === 'unknown' ? 'unconfirmed' : 'single';
  return { lead, supporting: sorted.slice(1, 4), independent, score, confirmation };
}

/* ------------------------------ the pipeline ------------------------------ */

export interface GatherArgs {
  req: NewsRequest;
  uid: string;
  store: SearchStore;
  limits: SearchLimits;
  service: SearchService;
  feeds: FeedDef[];
  /** the user asked for this search (toggle/phrase): may use the reserved daily credits */
  explicit: boolean;
  signal?: AbortSignal;
  now?: number;
  maxStories?: number;
}

/** Fewer stories than this inside the preferred window: widen once, and say so. */
const MIN_STORIES = 3;

const EDUCATION = /\b(education|educational|schools?|universit(?:y|ies)|students?|teachers?|pupils?|curriculum|tertiary|shs|jhs|basic school|exams?|waec|wassce|bece|scholarships?|ges|ministry of education)\b/i;
const GOVERNANCE = /\b(ministers?|ministry|parliament|mps?|cabinet|government|policy|policies|budget|tax(?:es|ation)?|president|vice president|presidency|assembly|regulat(?:or|ion|ory)|authority|commission)\b/i;
/** Broad country requests: the story must touch one of the requested sectors (one mention is enough). */
function mentionsSector(text: string, topics: Topic[]): boolean {
  if (matchesTopics(text, '', topics)) return true;
  if (EDUCATION.test(text)) return true;
  return topics.includes('politics') && GOVERNANCE.test(text);
}

function cacheHours(req: NewsRequest): number {
  const k = req.window.kind;
  return k === 'breaking' ? 0.25 : k === 'today' || k === 'latest' ? 0.5 : k === 'yesterday' ? 2 : 1;
}

export async function gatherNews(a: GatherArgs): Promise<NewsResult> {
  const now = a.now ?? Date.now();
  const { req } = a;
  const specific = tokens(req.keywords).filter((k) => !GENERIC.has(k));
  const query = [req.keywords || (req.region.id === 'world' ? 'world news' : 'news'), req.region.id !== 'world' && !req.keywords.toLowerCase().includes(req.region.label.toLowerCase()) ? req.region.label : '']
    .filter(Boolean)
    .join(' ')
    .trim();
  const providers: ProviderReport[] = [];
  const notices: string[] = [];

  const searchOne = async (id: SearchProviderId, throttle: boolean): Promise<NewsItem[]> => {
    const t0 = Date.now();
    const r = await a.service.run({
      uid: a.uid,
      store: a.store,
      limits: a.limits,
      query,
      intent: 'news',
      kind: 'news',
      max: 10,
      providers: [id],
      freshness: req.window.providerRange,
      sortByDate: id === 'serpapi',
      region: req.region.gl || req.region.country ? { gl: req.region.gl, country: req.region.country } : undefined,
      priority: a.explicit ? 'explicit' : 'auto',
      throttle,
      ttlHours: cacheHours(req),
      signal: a.signal,
    });
    if (!r.ok) {
      providers.push({ id, status: /not configured/.test(r.reason) ? 'skipped' : 'failed', articles: 0, reason: r.reason.replace(/ Answering without search\.$/, ''), ms: Date.now() - t0 });
      return [];
    }
    providers.push({ id, status: r.results.length ? 'ok' : 'empty', articles: r.results.length, cached: r.cached, ms: Date.now() - t0 });
    return r.results.map((x) => fromSearch(x, id, specific, now));
  };

  const chosenFeeds = feedsFor(req, a.feeds);
  const entityFeedIds = new Set(chosenFeeds.filter((x) => x.entities?.some((e) => req.entities.includes(e))).map((x) => x.id));
  const [serp, tavily, feedResults] = await Promise.all([
    searchOne('serpapi', true),
    searchOne('tavily', false),
    Promise.all(chosenFeeds.map((x) => readFeed(x, { now, signal: a.signal }))),
  ]);
  const feedItems = feedResults.flatMap((fr) => fr.items.map((it) => fromFeed(it, fr.feed, specific, entityFeedIds.has(fr.feed.id), now)));
  const okFeeds = feedResults.filter((x) => x.ok).length;
  providers.push({ id: 'rss', status: okFeeds ? (feedItems.length ? 'ok' : 'empty') : chosenFeeds.length ? 'failed' : 'skipped', articles: feedItems.length, reason: okFeeds ? undefined : 'no publisher feed could be read' });

  const all = [...serp, ...tavily, ...feedItems];
  const stats: NewsStats = { discovered: all.length, inWindow: 0, rejectedOld: 0, undated: 0, redated: 0, duplicates: 0, irrelevant: 0, feedsRead: okFeeds, feedsFailed: feedResults.length - okFeeds };
  const base = { request: req, retrievedAt: now, providers, feeds: feedResults, notices };

  if (!all.length) {
    const failedAll = providers.every((p) => p.status === 'failed' || p.status === 'skipped');
    return {
      ...base,
      stories: [],
      background: [],
      windowLabel: req.window.label,
      expanded: false,
      stats,
      failure: failedAll ? `current news could not be retrieved (${providers.map((p) => `${p.id}: ${p.reason ?? p.status}`).join('; ')})` : 'no articles were found for this request',
    };
  }

  // relevance: a feed chosen for the topic covers generic requests; specific subjects must be mentioned
  const minRel = specific.length ? 0.5 : 0;
  // scope: broad sources (world feeds, search results without the subject) must actually be about the
  // requested topic and region; "latest developments in Ghana" must not list Iraq or Love Island
  const feedById = new Map(chosenFeeds.map((f) => [f.id, f]));
  const topicsAsked: Topic[] = req.topics.filter((t) => t !== 'general');
  const regional = req.region.id !== 'world';
  // a national outlet speaks for its country; a continental or world feed (BBC Africa, AllAfrica) is
  // read for the region, but its items must name it
  const BROAD = ['world', 'africa', 'europe', 'asia', 'north_america', 'south_america', 'middle_east', 'oceania'];
  const regionFeed = (f: FeedDef) => f.regions.includes(req.region.id) && !f.regions.some((r) => BROAD.includes(r) && r !== req.region.id);
  const regionDomains = new Set(a.feeds.filter(regionFeed).map((f) => f.domain));
  const inScope = (x: NewsItem): boolean => {
    const f = x.feed ? feedById.get(x.feed) : undefined;
    if (f && entityFeedIds.has(f.id)) return true;
    const text = `${x.title} ${x.snippet}`;
    // several sectors of one country ("Ghana's technology, economy, government and education") is a request for that
    // country's news in general: the topic filter would drop most of it
    const broadRegional = regional && topicsAsked.length >= 3;
    if (broadRegional && !mentionsSector(text, topicsAsked)) return false;
    if (!broadRegional && topicsAsked.length && !specific.length && f && !f.topics.every((t) => topicsAsked.includes(t)) && !matchesTopics(x.title, x.snippet, topicsAsked)) return false;
    if (regional) {
      const local = (f && regionFeed(f)) || [...regionDomains].some((d) => x.domain === d || x.domain.endsWith(`.${d}`)) || (req.region.gl && x.domain.endsWith(`.${req.region.gl}`));
      if (!local && !matchesRegion(text, req.region.id)) return false;
      // national outlets also carry foreign stories; those are not developments in the country
      if (local && aboutElsewhere(x.title, req.region.id)) return false;
    }
    return true;
  };
  const relevant = all.filter((x) => {
    const ok = x.relevance >= minRel && inScope(x);
    if (!ok) stats.irrelevant++;
    return ok;
  });

  const inside = (x: NewsItem, since: number) => x.date.published != null && x.date.published >= since && (!req.window.until || x.date.published < req.window.until + 3_600_000);
  for (const x of relevant) {
    if (x.date.published == null) stats.undated++;
    if (x.date.redated) stats.redated++;
  }
  let since = req.window.since;
  let windowLabel = req.window.label;
  let expanded = false;
  let current = relevant.filter((x) => inside(x, since));
  let grouped = group(current);
  if (grouped.stories.length < MIN_STORIES && req.window.expandSince != null) {
    const wider = relevant.filter((x) => inside(x, req.window.expandSince!));
    const widerGroups = group(wider);
    if (widerGroups.stories.length > grouped.stories.length) {
      since = req.window.expandSince;
      windowLabel = req.window.expandLabel ?? windowLabel;
      expanded = true;
      current = wider;
      grouped = widerGroups;
    }
  }
  stats.inWindow = current.length;
  stats.rejectedOld = relevant.filter((x) => x.date.published != null && !inside(x, since)).length;
  stats.duplicates = grouped.duplicates;

  const stories = grouped.stories
    .map((items) => rankStory(items, since, now))
    // for a country or region, stories that name it come before untagged items from its outlets
    .map((st) => (regional && [st.lead, ...st.supporting].some((x) => matchesRegion(`${x.title} ${x.snippet}`, req.region.id)) ? { ...st, score: st.score + 0.3 } : st))
    .sort((x, y) => y.score - x.score)
    .slice(0, a.maxStories ?? 8);

  // older but clearly relevant reporting from credible sources: context only, labelled as such
  const background = specific.length
    ? relevant
        .filter((x) => x.date.published != null && x.date.published < since && x.relevance >= 0.75 && TIER_WEIGHT[x.tier] >= TIER_WEIGHT.regional)
        .sort((x, y) => (y.date.published ?? 0) - (x.date.published ?? 0))
        .filter((x, i, arr) => arr.findIndex((o) => similarity(tokens(o.title), tokens(x.title)) >= 0.45) === i)
        .slice(0, 3)
    : [];

  if (expanded) notices.push(`Few articles were published in ${req.window.label}, so the search window was widened to ${windowLabel}.`);
  return { ...base, stories, background, windowLabel, expanded, stats, failure: stories.length ? null : `no articles from ${windowLabel} could be verified` };
}

/* ------------------------------ brief for the model ------------------------------ */

const fmt = (ts: number | null) => (ts == null ? 'unknown' : `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

function dateLine(x: NewsItem): string {
  const d = x.date;
  if (d.published == null) return 'Published: unknown (no reliable date)';
  const basis = d.basis === 'feed' ? "publisher's feed" : d.basis === 'url' ? 'date in the article address' : 'search engine';
  const parts = [`Published: ${fmt(d.published)} (${basis}${d.status === 'confirmed' ? ', confirmed' : ', not independently confirmed'})`];
  if (d.redated) parts.push(`Note: this is an older article that was recently updated or re-indexed (${fmt(d.updated)}); it is not new`);
  else if (d.updated && d.updated - d.published > 3_600_000) parts.push(`Updated: ${fmt(d.updated)}`);
  return parts.join('. ');
}

const CONFIRMATION: Record<Story['confirmation'], string> = {
  official: 'Official announcement or primary source',
  multiple: 'Reported by several independent outlets',
  single: 'Reported by one outlet so far (not independently confirmed)',
  unconfirmed: 'Developing / unconfirmed: only social media or lesser-known sites',
};

/** Numbered sources for the UI and the prompt text. Sources start at `startIndex`. */
export function newsBrief(n: NewsResult, startIndex = 1): { text: string; sources: Source[] } {
  const sources: Source[] = [];
  const add = (x: NewsItem): number => {
    const existing = sources.find((s) => s.url === x.url);
    if (existing) return existing.index;
    const index = startIndex + sources.length;
    sources.push({
      index,
      kind: 'web',
      title: x.title,
      url: x.url,
      snippet: x.snippet.slice(0, 280),
      site: x.source,
      ...(x.origin !== 'rss' ? { provider: x.origin } : {}),
      ...(x.date.published != null ? { publishedDate: new Date(x.date.published).toISOString() } : {}),
    });
    return index;
  };
  const req = n.request;
  const lines: string[] = [];
  const where = req.region.id === 'world' ? 'worldwide' : req.region.label;
  const used = n.providers.filter((p) => p.status === 'ok').map((p) => (p.id === 'serpapi' ? 'Google News (SerpAPI)' : p.id === 'tavily' ? 'Tavily news search' : `${n.stats.feedsRead} publisher feed${n.stats.feedsRead === 1 ? '' : 's'}`));
  lines.push(
    `Retrieved: ${fmt(n.retrievedAt)}. Subject: ${req.keywords || 'top stories'} (${where}). Freshness window: ${n.windowLabel}${n.expanded ? ` (widened from ${req.window.label} because too few articles were published in it)` : ''}.`,
    `Checked ${n.stats.discovered} articles from ${used.join(', ') || 'no source'}: ${n.stats.rejectedOld} rejected as older than the window, ${n.stats.undated} excluded because their publication date could not be established, ${n.stats.duplicates} duplicates or syndicated copies merged${n.stats.redated ? `, ${n.stats.redated} old articles that had been re-dated or re-indexed detected` : ''}.`,
  );
  const failed = n.providers.filter((p) => p.status === 'failed');
  if (failed.length) lines.push(`Unavailable this time: ${failed.map((p) => `${p.id} (${p.reason})`).join('; ')}.`);
  lines.push('', '### Current stories');
  if (!n.stories.length) lines.push(`None could be verified in ${n.windowLabel}.`);
  n.stories.forEach((s, i) => {
    const lead = add(s.lead);
    lines.push(
      ``,
      `Story ${i + 1}: ${s.lead.title} [${lead}]`,
      `Source: ${s.lead.source} (${TIER_LABEL[s.lead.tier]}), ${s.lead.url}`,
      dateLine(s.lead),
      `Status: ${CONFIRMATION[s.confirmation]}; independent sources: ${s.independent}`,
    );
    if (s.supporting.length) lines.push(`Also reported by: ${s.supporting.map((x) => `${x.source} [${add(x)}] (${fmt(x.date.published)})`).join('; ')}`);
    if (s.lead.snippet) lines.push(`Summary from the source: ${s.lead.snippet}`);
  });
  if (n.background.length) {
    lines.push('', '### Background (older articles, for context only: NOT current news)');
    for (const x of n.background) lines.push(``, `${x.title} [${add(x)}]`, `Source: ${x.source}, ${x.url}`, dateLine(x), x.snippet ? `Summary: ${x.snippet}` : '');
  }
  return { text: lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n'), sources };
}
