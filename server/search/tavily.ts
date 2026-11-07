import { env } from '../env.js';
import { HttpError } from '../http.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchProvider {
  id: string;
  isConfigured(): boolean;
  search(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export class TavilySearch implements SearchProvider {
  readonly id = 'tavily';
  isConfigured() {
    return Boolean(env().tavilyKey);
  }
  async search(query: string, opts: { maxResults?: number; signal?: AbortSignal } = {}) {
    const key = env().tavilyKey;
    if (!key) throw new HttpError(503, 'search_unavailable', 'Web search is not configured.');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: query.slice(0, 400),
        max_results: opts.maxResults ?? 6,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
      }),
      signal: opts.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403)
      throw new HttpError(502, 'search_key', 'The web search provider rejected the API key.');
    if (res.status === 429 || res.status === 432)
      throw new HttpError(429, 'search_limit', 'The web search quota has been reached.');
    if (!res.ok) throw new HttpError(502, 'search_failed', 'Web search failed.');
    const data = (await res.json()) as {
      results?: { title: string; url: string; content: string; score?: number; published_date?: string }[];
    };
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      publishedDate: r.published_date,
    }));
  }
}

const provider: SearchProvider = new TavilySearch();
export function searchProvider(): SearchProvider {
  return provider;
}
