import { parseDate } from '../news/dates.js';
import {
  chargeSearch,
  searchKey,
  SearchError,
  hostOf,
  type AccountUsage,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
  type SearchResult,
} from './types.js';

interface SerpOrganic {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  date?: string;
  displayed_link?: string;
}
interface SerpNews {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string | { name?: string };
  date?: string;
}
interface SerpResponse {
  error?: string;
  organic_results?: SerpOrganic[];
  news_results?: SerpNews[];
  answer_box?: { answer?: string; snippet?: string; title?: string; link?: string };
  sports_results?: SerpSports;
}
interface SerpTeam {
  name?: string;
  score?: string | number;
}
interface SerpGame {
  tournament?: string;
  league?: string;
  stage?: string;
  date?: string;
  time?: string;
  status?: string;
  teams?: SerpTeam[];
}
interface SerpSports {
  title?: string;
  rankings?: string;
  ranking?: string;
  game_spotlight?: SerpGame;
  games?: SerpGame[];
}

const gameLine = (g: SerpGame): string => {
  const teams = (g.teams ?? []).filter((x) => x.name).map((x) => (x.score != null && x.score !== '' ? `${x.name} ${x.score}` : String(x.name)));
  if (!teams.length) return '';
  const when = [g.date, g.time].filter(Boolean).join(' ');
  return [teams.join(' - '), g.tournament || g.league, g.stage, g.status, when].filter(Boolean).join(', ');
};

/** Google's sports panel (team position, recent and next games) as plain text. Exported for tests. */
export function sportsSummary(s: SerpSports | undefined): string {
  if (!s) return '';
  const lines: string[] = [];
  if (s.title) lines.push(s.title);
  const rank = s.rankings || s.ranking;
  if (rank) lines.push(`Position: ${rank}`);
  const spot = s.game_spotlight ? gameLine(s.game_spotlight) : '';
  if (spot) lines.push(`Featured game: ${spot}`);
  const games = (s.games ?? []).map(gameLine).filter(Boolean).slice(0, 6);
  if (games.length) lines.push(`Games: ${games.join('; ')}`);
  return lines.length > 1 ? lines.join('. ') : '';
}

/** Map a SerpAPI JSON body to normalized results. Exported for tests. */
export function mapSerpResponse(data: SerpResponse, max: number, now = Date.now()): Omit<SearchResponse, 'credits'> {
  const rows: (SerpOrganic | SerpNews)[] = data.news_results?.length ? data.news_results : (data.organic_results ?? []);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.link || !r.title || seen.has(r.link)) continue;
    seen.add(r.link);
    const source = typeof r.source === 'object' ? r.source?.name : r.source;
    // Google reports news dates relative to the moment of the search ("3 hours ago"): resolve them
    // now, so a cached result keeps the true publication time instead of ageing backwards.
    const ts = r.date ? parseDate(r.date, now) : null;
    results.push({
      title: r.title,
      url: r.link,
      site: source || hostOf(r.link),
      snippet: (r.snippet ?? '').slice(0, 600),
      ...(r.date ? { publishedDate: ts != null ? new Date(ts).toISOString() : r.date, dateText: r.date } : {}),
    });
    if (results.length >= max) break;
  }
  const ab = data.answer_box;
  const sports = sportsSummary(data.sports_results);
  const answer = [sports ? `Google sports panel: ${sports}` : '', ab?.answer || ab?.snippet || ''].filter(Boolean).join(' | ') || undefined;
  return { results, ...(answer ? { answer: answer.slice(0, 800) } : {}) };
}

export class SerpApiSearch implements SearchProvider {
  readonly id = 'serpapi' as const;
  readonly label = 'SerpAPI (Google)';

  isConfigured() {
    return Boolean(searchKey('serpapi'));
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const key = searchKey('serpapi');
    if (!key) throw new SearchError('serpapi', 'not_configured', 'SerpAPI is not configured.');
    await chargeSearch('serpapi');
    const params = new URLSearchParams({
      engine: 'google',
      q: query.slice(0, 400),
      num: String(Math.min(Math.max(opts.max, 1), 10)),
      hl: 'en',
      api_key: key,
    });
    if (opts.kind === 'news') params.set('tbm', 'nws');
    const tbs: string[] = [];
    if (opts.freshness) tbs.push(`qdr:${opts.freshness[0]}`); // qdr:h / d / w / m / y
    if (opts.sortByDate && opts.kind === 'news') tbs.push('sbd:1');
    if (tbs.length) params.set('tbs', tbs.join(','));
    if (opts.region?.gl) params.set('gl', opts.region.gl);
    let res: Response;
    try {
      res = await fetch(`https://serpapi.com/search.json?${params}`, {
        signal: opts.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new SearchError('serpapi', 'timeout', 'SerpAPI did not respond in time.');
    }
    const data = (await res.json().catch(() => ({}))) as SerpResponse;
    if (res.status === 401 || res.status === 403) throw new SearchError('serpapi', 'key', 'SerpAPI rejected the API key.');
    if (res.status === 429) {
      const quota = /run out|plan|searches left|exceed/i.test(data.error ?? '');
      throw new SearchError(
        'serpapi',
        quota ? 'quota' : 'rate',
        quota ? 'The SerpAPI monthly search quota is used up.' : 'SerpAPI is rate limiting requests.',
      );
    }
    if (!res.ok) throw new SearchError('serpapi', 'failed', 'SerpAPI search failed.');
    // "no results" is reported as an error string with HTTP 200
    if (data.error && !/hasn't returned any results/i.test(data.error)) {
      throw new SearchError('serpapi', 'failed', 'SerpAPI search failed.');
    }
    return { ...mapSerpResponse(data, opts.max), credits: 1 };
  }

  async accountUsage(signal?: AbortSignal): Promise<AccountUsage | null> {
    const key = searchKey('serpapi');
    if (!key) return null;
    const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {
      signal: signal ?? AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      searches_per_month?: number;
      this_month_usage?: number;
      total_searches_left?: number;
      plan_name?: string;
      plan_renewal_date?: string;
    };
    const limit = d.searches_per_month ?? 0;
    const used = d.this_month_usage ?? 0;
    return {
      used,
      limit,
      remaining: d.total_searches_left ?? Math.max(0, limit - used),
      plan: d.plan_name,
      renews: d.plan_renewal_date,
    };
  }
}
