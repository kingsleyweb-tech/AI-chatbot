import {
  chargeSearch,
  searchKey,
  SearchError,
  hostOf,
  type AccountUsage,
  type ExtractResult,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
} from './types.js';

interface TavilySearchBody {
  answer?: string | null;
  results?: { title?: string; url?: string; content?: string; published_date?: string }[];
}

/** Map a Tavily /search body to normalized results. Exported for tests. */
export function mapTavilyResponse(data: TavilySearchBody, max: number): Omit<SearchResponse, 'credits'> {
  const results = (data.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, max)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      site: hostOf(r.url!),
      snippet: (r.content ?? '').slice(0, 600),
      content: (r.content ?? '').slice(0, 2000),
      ...(r.published_date ? { publishedDate: r.published_date } : {}),
    }));
  return { results, ...(data.answer ? { answer: data.answer.slice(0, 800) } : {}) };
}

function tavilyError(status: number): SearchError | null {
  if (status === 401 || status === 403) return new SearchError('tavily', 'key', 'Tavily rejected the API key.');
  // 432 = plan limit, 433 = pay-as-you-go limit
  if (status === 432 || status === 433) return new SearchError('tavily', 'quota', 'The Tavily monthly credit quota is used up.');
  if (status === 429) return new SearchError('tavily', 'rate', 'Tavily is rate limiting requests.');
  if (status >= 400) return new SearchError('tavily', 'failed', 'Tavily request failed.');
  return null;
}

export class TavilySearch implements SearchProvider {
  readonly id = 'tavily' as const;
  readonly label = 'Tavily';

  isConfigured() {
    return Boolean(searchKey('tavily'));
  }

  private async post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
    const key = searchKey('tavily');
    if (!key) throw new SearchError('tavily', 'not_configured', 'Tavily is not configured.');
    await chargeSearch('tavily');
    let res: Response;
    try {
      res = await fetch(`https://api.tavily.com${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(25_000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new SearchError('tavily', 'timeout', 'Tavily did not respond in time.');
    }
    const err = tavilyError(res.status);
    if (err) throw err;
    return (await res.json()) as T;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const depth = opts.depth ?? 'basic';
    const data = await this.post<TavilySearchBody>(
      '/search',
      {
        query: query.slice(0, 400),
        max_results: Math.min(Math.max(opts.max, 1), 10),
        search_depth: depth,
        topic: opts.kind === 'news' ? 'news' : 'general',
        ...(opts.freshness ? { time_range: opts.freshness === 'hour' ? 'day' : opts.freshness } : {}),
        // country boosting is only available for the general topic
        ...(opts.region?.country && opts.kind !== 'news' ? { country: opts.region.country } : {}),
        include_answer: false,
        include_raw_content: false,
      },
      opts.signal,
    );
    return { ...mapTavilyResponse(data, opts.max), credits: depth === 'advanced' ? 2 : 1 };
  }

  /** Read page content. Basic extraction costs 1 credit per 5 successful URLs. */
  async extract(urls: string[], signal?: AbortSignal): Promise<{ results: ExtractResult[]; credits: number }> {
    const data = await this.post<{ results?: { url: string; raw_content?: string; title?: string }[] }>(
      '/extract',
      { urls: urls.slice(0, 20), extract_depth: 'basic' },
      signal,
    );
    const results = (data.results ?? [])
      .filter((r) => r.raw_content?.trim())
      .map((r) => ({ url: r.url, title: r.title, content: r.raw_content!.slice(0, 12_000) }));
    return { results, credits: Math.ceil(results.length / 5) };
  }

  async accountUsage(signal?: AbortSignal): Promise<AccountUsage | null> {
    const key = searchKey('tavily');
    if (!key) return null;
    const res = await fetch('https://api.tavily.com/usage', {
      headers: { authorization: `Bearer ${key}` },
      signal: signal ?? AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { account?: { current_plan?: string; plan_usage?: number; plan_limit?: number } };
    const limit = d.account?.plan_limit ?? 0;
    const used = d.account?.plan_usage ?? 0;
    return { used, limit, remaining: Math.max(0, limit - used), plan: d.account?.current_plan };
  }
}
