/**
 * The single entry point for web search. Every search in the app goes
 * through here so that caching, de-duplication, throttling, budgets and
 * provider choice are enforced in one place.
 *
 * Rules:
 * - Cache first (shared across providers). A cache hit costs nothing.
 * - SerpAPI for general / news questions; Tavily for research, reference
 *   and page reading. Never both for the same question: the second provider
 *   is tried only if the first is unavailable, over budget, or fails.
 * - App budgets (daily / monthly, per provider) AND the provider's own
 *   reported remaining quota are checked before any paid request.
 * - When nothing is available the caller gets a reason to show the user
 *   and the chat continues without search.
 */
import type { SearchLimits } from '../shared/types.js';
import { SerpApiSearch } from './serpapi.js';
import { envOf } from '../environments/index.js';
import { cacheKey, findSimilar, normalizeQuery, searchUsageField, type CacheEntry, type SearchStore, type UsageEvent, type UsageSnapshot } from './store.js';
import { TavilySearch } from './tavily.js';
import {
  SearchError,
  type AccountUsage,
  type ExtractResult,
  type SearchIntent,
  type SearchKind,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderId,
  type SearchResult,
} from './types.js';

export interface Providers {
  serpapi: SearchProvider;
  tavily: SearchProvider & {
    extract(urls: string[], signal?: AbortSignal): Promise<{ results: ExtractResult[]; credits: number }>;
  };
}

export type RunResult =
  | {
      ok: true;
      provider: SearchProviderId;
      results: SearchResult[];
      answer?: string;
      cached: boolean;
      cachedAt?: string;
      /** reused a cached search for a differently worded, same-meaning question */
      similar?: boolean;
      notices: string[];
    }
  | { ok: false; reason: string; notices: string[] };

export type ExtractRunResult =
  | { ok: true; results: ExtractResult[]; cached: boolean; notices: string[] }
  | { ok: false; reason: string; notices: string[] };

export interface RunArgs {
  uid: string;
  store: SearchStore;
  limits: SearchLimits;
  query: string;
  intent: SearchIntent;
  kind?: SearchKind;
  max?: number;
  depth?: 'basic' | 'advanced';
  /** 'auto' searches cannot use the reserved last credits of the day */
  priority?: 'auto' | 'explicit';
  /** embedding of the query, enables meaning-based cache reuse */
  queryVector?: { vector: number[]; model: string } | null;
  /** apply the per-user rate limit (off for research sub-queries) */
  throttle?: boolean;
  /** only these providers, in this order (news uses each provider separately) */
  providers?: SearchProviderId[];
  freshness?: SearchOptions['freshness'];
  sortByDate?: boolean;
  region?: SearchOptions['region'];
  /** override the cache lifetime (hours), e.g. shorter for breaking news */
  ttlHours?: number;
  signal?: AbortSignal;
}

const LABEL: Record<SearchProviderId, string> = { serpapi: 'SerpAPI', tavily: 'Tavily' };

export function providerOrder(intent: SearchIntent): SearchProviderId[] {
  return intent === 'research' || intent === 'reference' ? ['tavily', 'serpapi'] : ['serpapi', 'tavily'];
}

export function ttlHours(intent: SearchIntent, limits: SearchLimits): number {
  if (intent === 'live') return limits.cacheTtlHours.live;
  return intent === 'news' ? limits.cacheTtlHours.news : intent === 'reference' ? limits.cacheTtlHours.reference : limits.cacheTtlHours.general;
}

function isFresh(entry: CacheEntry | null, now: number): entry is CacheEntry {
  return Boolean(entry && Date.parse(entry.expiresAt) > now);
}

/** Provider-reported usage is per account, so it is cached per API environment. */
const reportedKey = (id: SearchProviderId) => `${searchUsageField(id)}|${id}`;

/**
 * Search fallback stays inside one API environment: the providers tried are those in the
 * environment of the first usable provider (credentials are never mixed within a request).
 */
export function sameEnvironment(order: SearchProviderId[], usable: (id: SearchProviderId) => boolean): SearchProviderId[] {
  const envName = (id: SearchProviderId) => {
    try {
      return envOf(id);
    } catch {
      return null;
    }
  };
  const first = order.find(usable) ?? order[0];
  const e = first ? envName(first) : null;
  return e === null ? order : order.filter((id) => envName(id) === e);
}

export class SearchService {
  private inflight = new Map<string, Promise<RunResult | ExtractRunResult>>();
  private recent = new Map<string, number[]>();
  private reported = new Map<string, { usage: AccountUsage | null; at: number }>();

  constructor(
    readonly providers: Providers = { serpapi: new SerpApiSearch(), tavily: new TavilySearch() },
    private now: () => number = Date.now,
    private opts = { minGapMs: 3000, perMinute: 10, reportedTtlMs: 10 * 60_000 },
  ) {}

  configured(): SearchProviderId[] {
    return (Object.keys(this.providers) as SearchProviderId[]).filter((id) => this.providers[id].isConfigured());
  }

  /** Provider-reported plan usage, cached; adjusted locally after each request. */
  async reportedUsage(id: SearchProviderId, signal?: AbortSignal): Promise<AccountUsage | null> {
    const hit = this.reported.get(reportedKey(id));
    if (hit && this.now() - hit.at < this.opts.reportedTtlMs) return hit.usage;
    // unknown (null) means: rely on the app's own counters
    const usage = await this.providers[id].accountUsage(signal).catch(() => null);
    this.reported.set(reportedKey(id), { usage, at: this.now() });
    return usage;
  }

  private consumeReported(id: SearchProviderId, credits: number) {
    const hit = this.reported.get(reportedKey(id));
    if (hit?.usage) hit.usage = { ...hit.usage, used: hit.usage.used + credits, remaining: Math.max(0, hit.usage.remaining - credits) };
  }

  private markExhausted(id: SearchProviderId) {
    const hit = this.reported.get(reportedKey(id));
    const usage = hit?.usage ?? { used: 0, limit: 0, remaining: 0 };
    this.reported.set(reportedKey(id), { usage: { ...usage, remaining: 0 }, at: this.now() });
  }

  /** Why a provider cannot be used right now, or null when it can. */
  async blockReason(
    id: SearchProviderId,
    credits: number,
    usage: UsageSnapshot,
    limits: SearchLimits,
    signal?: AbortSignal,
    priority: 'auto' | 'explicit' = 'explicit',
  ): Promise<string | null> {
    if (!this.providers[id].isConfigured()) return `${LABEL[id]} is not configured`;
    const l = limits[id];
    if (usage.day[id] + credits > l.daily) return `${LABEL[id]} daily limit (${l.daily}) reached`;
    // keep the last few credits of the day for searches the user explicitly asks for
    if (priority === 'auto' && usage.day[id] + credits > l.daily - (limits.autoReserve ?? 0))
      return `${LABEL[id]} daily budget for automatic searches is used up (the rest is kept for searches you ask for)`;
    if (usage.month[id] + credits > l.monthly) return `${LABEL[id]} monthly limit (${l.monthly}) reached`;
    const acct = await this.reportedUsage(id, signal);
    if (acct && acct.remaining - credits < limits.providerReserve) return `${LABEL[id]} plan quota is used up`;
    return null;
  }

  private throttled(uid: string): boolean {
    const now = this.now();
    const list = (this.recent.get(uid) ?? []).filter((t) => now - t < 60_000);
    const last = list[list.length - 1];
    if ((last !== undefined && now - last < this.opts.minGapMs) || list.length >= this.opts.perMinute) {
      this.recent.set(uid, list);
      return true;
    }
    list.push(now);
    this.recent.set(uid, list);
    return false;
  }

  async run(args: RunArgs): Promise<RunResult> {
    const normalized = normalizeQuery(args.query);
    if (!normalized) return { ok: false, reason: 'The message had nothing to search for.', notices: [] };
    const kind = args.kind ?? (args.intent === 'news' ? 'news' : 'web');
    // freshness, region and provider restrictions change the answer, so they are part of the cache key
    const variant = [args.freshness ? `f=${args.freshness}` : '', args.sortByDate ? 'sbd' : '', args.region?.gl ? `gl=${args.region.gl}` : '', args.providers ? `p=${args.providers.join('+')}` : '']
      .filter(Boolean)
      .join(',');
    const key = cacheKey(`search:${kind}${variant ? `|${variant}` : ''}`, normalized);

    const cached = await args.store.getCache(key);
    if (isFresh(cached, this.now())) {
      await args.store.record([{ provider: cached.provider, type: 'cached', credits: 0 }]);
      return {
        ok: true,
        provider: cached.provider,
        results: cached.results,
        answer: cached.answer,
        cached: true,
        cachedAt: cached.createdAt,
        notices: [],
      };
    }

    // Same question in other words, still fresh? Reuse it (no credit).
    if (args.queryVector && args.store.recentCache && !variant) {
      const similar = findSimilar(await args.store.recentCache(40), `search:${kind}`, normalized, args.queryVector, this.now());
      if (similar) {
        await args.store.record([{ provider: similar.provider, type: 'cached', credits: 0 }]);
        return {
          ok: true,
          provider: similar.provider,
          results: similar.results,
          answer: similar.answer,
          cached: true,
          similar: true,
          cachedAt: similar.createdAt,
          notices: [],
        };
      }
    }

    const flightKey = `${args.uid}|${key}`;
    const pending = this.inflight.get(flightKey);
    if (pending) return pending as Promise<RunResult>;
    const p = this.fetchFresh(args, normalized, kind, key).finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, p);
    return p;
  }

  private async fetchFresh(args: RunArgs, normalized: string, kind: SearchKind, key: string): Promise<RunResult> {
    if (args.throttle !== false && this.throttled(args.uid)) {
      return { ok: false, reason: 'Searches are being sent too quickly, so this answer uses no new search.', notices: [] };
    }
    const usage = await args.store.getUsage();
    const notices: string[] = [];
    const blocked: string[] = [];
    const events: UsageEvent[] = [];
    const max = Math.min(args.max ?? 6, 10);
    try {
      for (const id of sameEnvironment(args.providers ?? providerOrder(args.intent), (p) => this.providers[p].isConfigured())) {
        const credits = id === 'tavily' && args.depth === 'advanced' ? 2 : 1;
        const reason = await this.blockReason(id, credits, usage, args.limits, args.signal, args.priority ?? 'explicit');
        if (reason) {
          blocked.push(reason);
          continue;
        }
        try {
          const res = await this.providers[id].search(args.query, {
            kind,
            max,
            depth: args.depth,
            signal: args.signal,
            ...(args.freshness ? { freshness: args.freshness } : {}),
            ...(args.sortByDate ? { sortByDate: true } : {}),
            ...(args.region ? { region: args.region } : {}),
          });
          events.push({ provider: id, type: 'request', credits: res.credits });
          this.consumeReported(id, res.credits);
          const createdAt = new Date(this.now()).toISOString();
          const ttl = args.ttlHours ?? ttlHours(args.intent, args.limits);
          if (ttl > 0 && res.results.length) {
            await args.store.putCache(key, {
              query: normalized,
              provider: id,
              results: res.results,
              ...(res.answer ? { answer: res.answer } : {}),
              scope: `search:${kind}`,
              ...(args.queryVector ? { vector: args.queryVector.vector, vectorModel: args.queryVector.model } : {}),
              createdAt,
              expiresAt: new Date(this.now() + ttl * 3_600_000).toISOString(),
            });
          }
          const shown = blocked.filter((b) => !/not configured/.test(b));
          if (shown.length) notices.push(`${shown.join('; ')}, so ${LABEL[id]} was used for this search.`);
          return { ok: true, provider: id, results: res.results, answer: res.answer, cached: false, notices };
        } catch (err) {
          if (!(err instanceof SearchError)) throw err;
          events.push({ provider: id, type: 'failed', credits: 0 });
          if (err.code === 'quota') this.markExhausted(id);
          blocked.push(err.message.replace(/\.$/, ''));
        }
      }
    } finally {
      await args.store.record(events);
    }
    const allBudget = blocked.length > 0 && blocked.every((b) => /limit|quota|not configured/.test(b));
    return {
      ok: false,
      reason: allBudget
        ? `Web search is unavailable (${blocked.join('; ')}). Answering without search.`
        : `Web search failed (${blocked.join('; ') || 'no provider available'}). Answering without search.`,
      notices,
    };
  }

  /** Read the content of specific pages (Tavily extract), cached per URL set. */
  async extract(args: Omit<RunArgs, 'query' | 'intent' | 'kind' | 'depth'> & { urls: string[] }): Promise<ExtractRunResult> {
    const urls = [...new Set(args.urls)].slice(0, 5);
    if (!urls.length) return { ok: false, reason: 'No pages to read.', notices: [] };
    const key = cacheKey('extract', urls.slice().sort().join(' '));
    const cached = await args.store.getCache(key);
    if (isFresh(cached, this.now()) && cached.extracts?.length) {
      await args.store.record([{ provider: 'tavily', type: 'cached', credits: 0 }]);
      return { ok: true, results: cached.extracts, cached: true, notices: [] };
    }
    const flightKey = `${args.uid}|${key}`;
    const pending = this.inflight.get(flightKey);
    if (pending) return pending as Promise<ExtractRunResult>;
    const p = (async (): Promise<ExtractRunResult> => {
      if (args.throttle !== false && this.throttled(args.uid)) {
        return { ok: false, reason: 'Requests are being sent too quickly, so the page was not read.', notices: [] };
      }
      const usage = await args.store.getUsage();
      const credits = Math.ceil(urls.length / 5);
      const reason = await this.blockReason('tavily', credits, usage, args.limits, args.signal);
      if (reason) return { ok: false, reason: `Page reading is unavailable (${reason}).`, notices: [] };
      try {
        const res = await this.providers.tavily.extract(urls, args.signal);
        await args.store.record([{ provider: 'tavily', type: 'request', credits: res.credits }]);
        this.consumeReported('tavily', res.credits);
        if (res.results.length) {
          await args.store.putCache(key, {
            query: urls.join(' '),
            provider: 'tavily',
            results: [],
            extracts: res.results,
            createdAt: new Date(this.now()).toISOString(),
            expiresAt: new Date(this.now() + args.limits.cacheTtlHours.general * 3_600_000).toISOString(),
          });
        }
        return res.results.length
          ? { ok: true, results: res.results, cached: false, notices: [] }
          : { ok: false, reason: 'The page could not be read (it may block automated access).', notices: [] };
      } catch (err) {
        if (!(err instanceof SearchError)) throw err;
        await args.store.record([{ provider: 'tavily', type: 'failed', credits: 0 }]);
        if (err.code === 'quota') this.markExhausted('tavily');
        return { ok: false, reason: `${err.message} The page was not read.`, notices: [] };
      }
    })().finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, p);
    return p;
  }
}

let service: SearchService | null = null;
export function searchService(): SearchService {
  return (service ??= new SearchService());
}
