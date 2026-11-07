import { env } from '../env.js';
import {
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
}

/** Map a SerpAPI JSON body to normalized results. Exported for tests. */
export function mapSerpResponse(data: SerpResponse, max: number): Omit<SearchResponse, 'credits'> {
  const rows: (SerpOrganic | SerpNews)[] = data.news_results?.length ? data.news_results : (data.organic_results ?? []);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.link || !r.title || seen.has(r.link)) continue;
    seen.add(r.link);
    const source = typeof r.source === 'object' ? r.source?.name : r.source;
    results.push({
      title: r.title,
      url: r.link,
      site: source || hostOf(r.link),
      snippet: (r.snippet ?? '').slice(0, 600),
      ...(r.date ? { publishedDate: r.date } : {}),
    });
    if (results.length >= max) break;
  }
  const ab = data.answer_box;
  const answer = ab?.answer || ab?.snippet || undefined;
  return { results, ...(answer ? { answer: answer.slice(0, 800) } : {}) };
}

export class SerpApiSearch implements SearchProvider {
  readonly id = 'serpapi' as const;
  readonly label = 'SerpAPI (Google)';

  isConfigured() {
    return Boolean(env().serpApiKey);
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const key = env().serpApiKey;
    if (!key) throw new SearchError('serpapi', 'not_configured', 'SerpAPI is not configured.');
    const params = new URLSearchParams({
      engine: 'google',
      q: query.slice(0, 400),
      num: String(Math.min(Math.max(opts.max, 1), 10)),
      hl: 'en',
      api_key: key,
    });
    if (opts.kind === 'news') params.set('tbm', 'nws');
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
    const key = env().serpApiKey;
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
