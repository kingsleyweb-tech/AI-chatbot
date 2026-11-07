import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, normalizeLimits } from '../server/config/limits.js';
import { classifyIntent, extractUrls, looksLikeFollowUp, needsWebSearch, toSearchQuery } from '../server/search/heuristics.js';
import { pickPages, planQueries, runResearch } from '../server/search/research.js';
import { SearchService, providerOrder, type Providers } from '../server/search/router.js';
import { mapSerpResponse } from '../server/search/serpapi.js';
import { MemorySearchStore, cacheKey, normalizeQuery } from '../server/search/store.js';
import { mapTavilyResponse } from '../server/search/tavily.js';
import { SearchError, type AccountUsage, type SearchProviderId, type SearchResult } from '../server/search/types.js';
import { searchTrigger } from '../server/search/web.js';

const result = (n: number, host = 'example.com'): SearchResult => ({
  title: `Result ${n}`,
  url: `https://${host}/${n}`,
  site: host,
  snippet: `snippet ${n}`,
});

function fakeProviders(opts: {
  serp?: () => Promise<SearchResult[]>;
  tavily?: () => Promise<SearchResult[]>;
  serpUsage?: AccountUsage | null;
  tavilyUsage?: AccountUsage | null;
  configured?: Partial<Record<SearchProviderId, boolean>>;
} = {}) {
  const calls = { serpapi: 0, tavily: 0, extract: 0 };
  const providers: Providers = {
    serpapi: {
      id: 'serpapi',
      label: 'SerpAPI',
      isConfigured: () => opts.configured?.serpapi ?? true,
      search: async () => {
        calls.serpapi++;
        return { results: await (opts.serp ?? (async () => [result(1), result(2)]))(), credits: 1 };
      },
      accountUsage: async () => (opts.serpUsage === undefined ? { used: 0, limit: 250, remaining: 250 } : opts.serpUsage),
    },
    tavily: {
      id: 'tavily',
      label: 'Tavily',
      isConfigured: () => opts.configured?.tavily ?? true,
      search: async (_q, o) => {
        calls.tavily++;
        return { results: await (opts.tavily ?? (async () => [result(3, 'tavily.dev')]))(), credits: o.depth === 'advanced' ? 2 : 1 };
      },
      extract: async (urls) => {
        calls.extract++;
        return { results: urls.map((url) => ({ url, content: `content of ${url}` })), credits: Math.ceil(urls.length / 5) };
      },
      accountUsage: async () => (opts.tavilyUsage === undefined ? { used: 0, limit: 1000, remaining: 1000 } : opts.tavilyUsage),
    },
  };
  return { providers, calls };
}

const base = { uid: 'u1', limits: DEFAULT_LIMITS };
const fastOpts = { minGapMs: 0, perMinute: 1000, reportedTtlMs: 60_000 };

describe('provider response mapping', () => {
  it('maps SerpAPI organic results with site, snippet and only reported dates', () => {
    const out = mapSerpResponse(
      {
        organic_results: [
          { title: 'A', link: 'https://www.a.com/x', snippet: 'about a', source: 'A News', date: 'Nov 5, 2026' },
          { title: 'B', link: 'https://b.org/y', snippet: 'about b' },
          { title: 'dup', link: 'https://b.org/y' },
          { link: 'https://no-title.com' },
        ],
        answer_box: { answer: '42' },
      },
      6,
    );
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ title: 'A', site: 'A News', publishedDate: 'Nov 5, 2026' });
    expect(out.results[1]).toMatchObject({ site: 'b.org' });
    expect(out.results[1]).not.toHaveProperty('publishedDate');
    expect(out.answer).toBe('42');
  });

  it('prefers SerpAPI news results and reads nested source names', () => {
    const out = mapSerpResponse({ news_results: [{ title: 'N', link: 'https://n.com', source: { name: 'Wire' }, date: '2 hours ago' }] }, 6);
    expect(out.results[0]).toMatchObject({ site: 'Wire', publishedDate: '2 hours ago' });
  });

  it('maps Tavily results and respects the limit', () => {
    const out = mapTavilyResponse(
      { results: [1, 2, 3].map((n) => ({ title: `T${n}`, url: `https://www.t.com/${n}`, content: 'c'.repeat(3000), published_date: n === 1 ? '2026-11-01' : undefined })) },
      2,
    );
    expect(out.results).toHaveLength(2);
    expect(out.results[0].site).toBe('t.com');
    expect(out.results[0].content).toHaveLength(2000);
    expect(out.results[0].publishedDate).toBe('2026-11-01');
    expect(out.results[1]).not.toHaveProperty('publishedDate');
  });
});

describe('search heuristics', () => {
  it.each([
    'What is the latest news on the Mars mission?',
    'search for vegan restaurants in Accra',
    'what is the weather in London',
    'Who won the election results yesterday?',
    'summarize https://example.com/article',
    'What happened in AI in 2027?',
    'bitcoin price today?',
  ])('searches for %s', (q) => expect(needsWebSearch(q)).toBe(true));

  it.each([
    'Explain how photosynthesis works',
    'Write a poem about the sea',
    'How do I get the current directory in Python?',
    'hi, how are you',
    'Refactor this function: const x = 1;',
    'What is the capital of France?',
  ])('does not search for %s', (q) => expect(needsWebSearch(q)).toBe(false));

  it('classifies intent for provider routing', () => {
    expect(classifyIntent('latest news on chips')).toEqual({ intent: 'news', kind: 'news' });
    expect(classifyIntent('compare postgres vs mysql performance studies').intent).toBe('research');
    expect(classifyIntent('react useEffect documentation').intent).toBe('reference');
    expect(classifyIntent('best hiking boots').intent).toBe('general');
  });

  it('builds compact queries and extracts URLs', () => {
    expect(toSearchQuery('Hey, can you search the web for: best laptops for students')).toBe('best laptops for students');
    expect(extractUrls('read https://a.com/x, and https://a.com/x.')).toEqual(['https://a.com/x']);
    expect(looksLikeFollowUp('what about in 2025?')).toBe(true);
    expect(looksLikeFollowUp('Explain the history of the Roman empire in detail please')).toBe(false);
  });

  it('decides the trigger from toggles and the message', () => {
    expect(searchTrigger('hello', { webSearch: false, autoSearch: true })).toBeNull();
    expect(searchTrigger('hello', { webSearch: true })).toBe('manual');
    expect(searchTrigger('latest news today?', { webSearch: false, autoSearch: false })).toBeNull();
    expect(searchTrigger('latest news today?', { webSearch: false, autoSearch: true })).toBe('auto');
    expect(searchTrigger('see https://x.com', { webSearch: false, autoSearch: true })).toBe('url');
    expect(searchTrigger('anything', { webSearch: false, deepResearch: true })).toBe('research');
  });
});

describe('cache keys', () => {
  it('normalizes case, punctuation and filler words', () => {
    expect(normalizeQuery('What is the Price of Bitcoin?')).toBe(normalizeQuery('what is price of bitcoin'));
    expect(normalizeQuery('Please search for: Node.js 24 release!!')).toBe('node.js 24 release');
    expect(normalizeQuery('C++ vs C#')).toBe('c++ vs c#');
    expect(cacheKey('search:web', 'a')).not.toBe(cacheKey('search:news', 'a'));
  });
});

describe('search router', () => {
  it('routes general questions to SerpAPI and research to Tavily', async () => {
    expect(providerOrder('general')).toEqual(['serpapi', 'tavily']);
    expect(providerOrder('news')[0]).toBe('serpapi');
    expect(providerOrder('research')[0]).toBe('tavily');
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const r1 = await svc.run({ ...base, store, query: 'best laptops', intent: 'general' });
    const r2 = await svc.run({ ...base, store, query: 'deep comparison of laptops', intent: 'research' });
    expect(r1.ok && r1.provider).toBe('serpapi');
    expect(r2.ok && r2.provider).toBe('tavily');
    expect(calls).toMatchObject({ serpapi: 1, tavily: 1 });
  });

  it('serves a repeated query from cache without spending a credit', async () => {
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    await svc.run({ ...base, store, query: 'Price of gold?', intent: 'general' });
    const again = await svc.run({ ...base, store, query: 'price of gold', intent: 'general' });
    expect(calls.serpapi).toBe(1);
    expect(again.ok && again.cached).toBe(true);
    expect(store.usage.day.serpapi).toBe(1);
    expect(store.events.map((e) => e.type)).toEqual(['request', 'cached']);
  });

  it('re-fetches after the cache entry expires', async () => {
    let now = Date.parse('2026-11-07T10:00:00Z');
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, () => now, fastOpts);
    const store = new MemorySearchStore();
    await svc.run({ ...base, store, query: 'breaking news', intent: 'news' });
    now += 3 * 3_600_000; // news TTL is 2h
    await svc.run({ ...base, store, query: 'breaking news', intent: 'news' });
    expect(calls.serpapi).toBe(2);
  });

  it('de-duplicates identical searches that are in flight at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { providers, calls } = fakeProviders({ serp: async () => (await gate, [result(1)]) });
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const a = svc.run({ ...base, store, query: 'same thing', intent: 'general' });
    const b = svc.run({ ...base, store, query: 'same thing', intent: 'general' });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls.serpapi).toBe(1);
    expect(ra).toEqual(rb);
  });

  it('falls back to Tavily when SerpAPI fails, and never queries both on success', async () => {
    const { providers, calls } = fakeProviders({
      serp: async () => {
        throw new SearchError('serpapi', 'failed', 'SerpAPI search failed.');
      },
    });
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const r = await svc.run({ ...base, store, query: 'q1', intent: 'general' });
    expect(r.ok && r.provider).toBe('tavily');
    expect(r.notices[0]).toMatch(/SerpAPI search failed.*Tavily was used/);
    expect(calls).toMatchObject({ serpapi: 1, tavily: 1 });
    expect(store.events.map((e) => `${e.provider}:${e.type}`)).toEqual(['serpapi:failed', 'tavily:request']);
  });

  it('switches provider visibly when the SerpAPI daily limit is reached', async () => {
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    store.usage.day.serpapi = DEFAULT_LIMITS.serpapi.daily;
    const r = await svc.run({ ...base, store, query: 'q2', intent: 'general' });
    expect(calls.serpapi).toBe(0);
    expect(r.ok && r.provider).toBe('tavily');
    expect(r.notices[0]).toMatch(/SerpAPI daily limit \(8\) reached/);
  });

  it('stops searching when both providers are out of budget and explains why', async () => {
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    store.usage.month.serpapi = DEFAULT_LIMITS.serpapi.monthly;
    store.usage.day.tavily = DEFAULT_LIMITS.tavily.daily;
    const r = await svc.run({ ...base, store, query: 'q3', intent: 'general' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/unavailable \(SerpAPI monthly limit \(200\) reached; Tavily daily limit \(30\) reached\)/);
    expect(calls).toMatchObject({ serpapi: 0, tavily: 0 });
  });

  it('respects the provider-reported quota even when app counters are low', async () => {
    const { providers, calls } = fakeProviders({ serpUsage: { used: 248, limit: 250, remaining: 2 } });
    const svc = new SearchService(providers, Date.now, fastOpts);
    const r = await svc.run({ ...base, store: new MemorySearchStore(), query: 'q4', intent: 'general' });
    expect(calls.serpapi).toBe(0);
    expect(r.ok && r.provider).toBe('tavily');
    expect(r.notices[0]).toMatch(/SerpAPI plan quota is used up/);
  });

  it('marks a provider exhausted after a quota error so later searches skip it', async () => {
    const { providers, calls } = fakeProviders({
      serp: async () => {
        throw new SearchError('serpapi', 'quota', 'The SerpAPI monthly search quota is used up.');
      },
    });
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    await svc.run({ ...base, store, query: 'first', intent: 'general' });
    await svc.run({ ...base, store, query: 'second', intent: 'general' });
    expect(calls.serpapi).toBe(1);
    expect(calls.tavily).toBe(2);
  });

  it('skips unconfigured providers silently', async () => {
    const { providers } = fakeProviders({ configured: { serpapi: false } });
    const svc = new SearchService(providers, Date.now, fastOpts);
    const r = await svc.run({ ...base, store: new MemorySearchStore(), query: 'q5', intent: 'general' });
    expect(r.ok && r.provider).toBe('tavily');
    expect(r.notices).toEqual([]);
  });

  it('throttles rapid searches from the same user', async () => {
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, { minGapMs: 3000, perMinute: 10, reportedTtlMs: 60_000 });
    const store = new MemorySearchStore();
    await svc.run({ ...base, store, query: 'one', intent: 'general' });
    const r = await svc.run({ ...base, store, query: 'two', intent: 'general' });
    expect(r.ok).toBe(false);
    expect(calls.serpapi).toBe(1);
    const notThrottled = await svc.run({ ...base, store, query: 'three', intent: 'general', throttle: false });
    expect(notThrottled.ok).toBe(true);
  });

  it('caches page extraction and charges 1 credit per 5 pages', async () => {
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const urls = ['https://a.com', 'https://b.com'];
    const r1 = await svc.extract({ ...base, store, urls });
    const r2 = await svc.extract({ ...base, store, urls: [...urls].reverse() });
    expect(r1.ok && r1.results).toHaveLength(2);
    expect(r2.ok && r2.cached).toBe(true);
    expect(calls.extract).toBe(1);
    expect(store.usage.day.tavily).toBe(1);
  });
});

describe('limits', () => {
  it('clamps stored values and fills gaps with defaults', () => {
    const l = normalizeLimits({ serpapi: { daily: -5 }, research: { maxSearches: 999 }, providerReserve: 'x' });
    expect(l.serpapi).toEqual({ daily: 0, monthly: 200 });
    expect(l.research).toEqual({ maxSearches: 20, maxPageReads: 4 });
    expect(l.providerReserve).toBe(5);
    expect(normalizeLimits(null)).toEqual(DEFAULT_LIMITS);
  });
});

describe('deep research', () => {
  it('plans sub-queries from model JSON, dropping duplicates and capping the count', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({ queries: [{ q: 'a', intent: 'news' }, { q: 'A' }, { q: 'b', intent: 'bogus' }, { q: 'c' }] }),
    );
    const plan = await planQueries('question', 2, complete);
    expect(plan).toEqual([
      { q: 'a', intent: 'news' },
      { q: 'b', intent: 'general' },
    ]);
  });

  it('falls back to the question when planning fails', async () => {
    const plan = await planQueries('what is new in rust', 3, async () => null);
    expect(plan).toHaveLength(1);
    expect(plan[0].q).toBe('what is new in rust');
  });

  it('picks the top page of each sub-query first', () => {
    const pages = pickPages(
      [
        { url: 'a1', fromQuery: 'a' },
        { url: 'a2', fromQuery: 'a' },
        { url: 'b1', fromQuery: 'b' },
        { url: 'c1', fromQuery: 'c' },
      ],
      3,
    );
    expect(pages).toEqual(['a1', 'b1', 'c1']);
  });

  it('stays within the search and page-read budget and reports steps', async () => {
    let n = 0;
    const { providers, calls } = fakeProviders({ serp: async () => [result(++n), result(++n)], tavily: async () => [result(++n, 't.dev')] });
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const limits = { ...DEFAULT_LIMITS, research: { maxSearches: 3, maxPageReads: 2 } };
    const steps: string[] = [];
    const res = await runResearch({
      service: svc,
      store,
      limits,
      uid: 'u1',
      question: 'q',
      onStep: (s) => steps.push(s.kind),
      plan: [
        { q: 'one', intent: 'general' },
        { q: 'two', intent: 'research' },
        { q: 'three', intent: 'news' },
        { q: 'four', intent: 'general' },
      ],
    });
    expect(calls.serpapi + calls.tavily).toBe(3);
    expect(calls.extract).toBe(1);
    expect(res.pagesRead).toBe(2);
    expect(res.results.filter((r) => r.content?.startsWith('content of'))).toHaveLength(2);
    expect(steps).toEqual(['plan', 'search', 'search', 'search', 'read', 'done']);
  });

  it('stops spending when budgets run out mid-research', async () => {
    const { providers, calls } = fakeProviders();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    store.usage.day.serpapi = 8;
    store.usage.day.tavily = 30;
    const res = await runResearch({
      service: svc,
      store,
      limits: DEFAULT_LIMITS,
      uid: 'u1',
      question: 'q',
      onStep: () => undefined,
      plan: [
        { q: 'one', intent: 'general' },
        { q: 'two', intent: 'general' },
      ],
    });
    expect(calls).toMatchObject({ serpapi: 0, tavily: 0, extract: 0 });
    expect(res.steps.filter((s) => s.kind === 'skip')).toHaveLength(1);
  });
});
