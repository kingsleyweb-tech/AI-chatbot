/**
 * Persistence for the search service: the per-user result cache and the
 * per-provider usage counters. Firestore in production; in-memory in tests.
 */
import { createHash } from 'node:crypto';
import { cosine } from '../embeddings.js';
import { fieldPath, SERVER_TIME, type Firestore, type Write } from '../firestore.js';
import type { ExtractResult, SearchProviderId, SearchResult } from './types.js';

export interface CacheEntry {
  query: string;
  provider: SearchProviderId;
  results: SearchResult[];
  extracts?: ExtractResult[];
  answer?: string;
  createdAt: string;
  expiresAt: string;
  /** cache scope, e.g. "search:news" (for similarity lookups) */
  scope?: string;
  /** query embedding for meaning-based reuse */
  vector?: number[];
  vectorModel?: string;
}

/** Similarity lookups need at least this cosine AND the same distinctive words. */
export const SIMILAR_MIN = 0.87;

export type ProviderCount = Record<SearchProviderId, number>;
export interface UsageSnapshot {
  /** credits used today / this month, as tracked by the app */
  day: ProviderCount;
  month: ProviderCount;
}

export interface UsageEvent {
  provider: SearchProviderId;
  type: 'request' | 'cached' | 'failed';
  credits: number;
}

export interface SearchStore {
  getCache(key: string): Promise<CacheEntry | null>;
  putCache(key: string, entry: CacheEntry): Promise<void>;
  getUsage(): Promise<UsageSnapshot>;
  record(events: UsageEvent[]): Promise<void>;
  /** recent cache entries, newest first (for meaning-based reuse) */
  recentCache?(limit: number): Promise<CacheEntry[]>;
}

/** Words that say HOW a query asks, not what it is about. */
const GENERIC = new Set(
  'latest news new today now update updates price prices version release who what when where which how why president ceo weather forecast info information details current recent'.split(' '),
);
export function distinctiveTokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t && !GENERIC.has(t));
}

/** A fresh cached entry that answers the same question in other words, if any. */
export function findSimilar(
  entries: CacheEntry[],
  scope: string,
  normalized: string,
  vec: { vector: number[]; model: string },
  now: number,
): CacheEntry | null {
  const mine = new Set(distinctiveTokens(normalized));
  let best: { e: CacheEntry; score: number } | null = null;
  for (const e of entries) {
    if (e.scope !== scope || !e.vector || e.vectorModel !== vec.model || Date.parse(e.expiresAt) <= now) continue;
    const theirs = new Set(distinctiveTokens(e.query));
    // the distinctive words must match exactly: Ghana vs Nigeria, React vs Vue never reuse
    if (theirs.size !== mine.size || ![...theirs].every((t) => mine.has(t))) continue;
    const score = cosine(vec.vector, e.vector);
    if (score >= SIMILAR_MIN && (!best || score > best.score)) best = { e, score };
  }
  return best?.e ?? null;
}

/** Phrase synonyms so paraphrases share one cache key. */
const SYNONYMS: [RegExp, string][] = [
  [/\bartificial intelligence\b/g, 'ai'],
  [/\bmachine learning\b/g, 'ml'],
  [/\b(?:most recent|newest|recent|current|up to date|up-to-date)\b/g, 'latest'],
  [/\bheadlines\b/g, 'news'],
];

const STOP = new Set(
  'a an the please pls can could would will you tell me about search for find look up google online web internet i is are do does of to on in at and or with some any give show'.split(
    ' ',
  ),
);

/** Lowercase, strip punctuation and filler words, collapse whitespace. */
export function normalizeQuery(q: string): string {
  const tokens = q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/^[\s\S]*$/, (s) => SYNONYMS.reduce((acc, [re, to]) => acc.replace(re, to), s))
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t && !STOP.has(t));
  const seen = new Set<string>();
  return tokens.filter((t) => (seen.has(t) ? false : (seen.add(t), true))).join(' ');
}

/** Word order does not change the key ("ai news latest" = "latest ai news"). */
export function cacheKey(scope: string, normalized: string): string {
  const canonical = normalized.split(' ').sort().join(' ');
  return createHash('sha1').update(`${scope}|${canonical}`).digest('hex').slice(0, 32);
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export const monthKey = (d = new Date()) => `m-${d.toISOString().slice(0, 7)}`;

const empty = (): ProviderCount => ({ serpapi: 0, tavily: 0 });

export class FirestoreSearchStore implements SearchStore {
  /**
   * `usageDb` writes the budget counters (users/{uid}/usage): the server
   * identity in production, because the rules make those counters read-only
   * for the user, so nobody can reset their own search budget.
   */
  constructor(
    private db: Firestore,
    private uid: string,
    private usageDb: Firestore = db,
  ) {}

  private get base() {
    return `users/${this.uid}`;
  }

  async getCache(key: string): Promise<CacheEntry | null> {
    const doc = await this.db.get<CacheEntry>(`${this.base}/searchCache/${key}`).catch(() => null);
    return doc?.data ?? null;
  }

  async putCache(key: string, entry: CacheEntry): Promise<void> {
    await this.db.set(`${this.base}/searchCache/${key}`, entry).catch((err) => {
      console.warn('[search] cache write failed', err instanceof Error ? err.message : err);
    });
  }

  async recentCache(limit: number): Promise<CacheEntry[]> {
    const docs = await this.db
      .list<CacheEntry>(`${this.base}/searchCache`, { orderBy: 'createdAt', direction: 'DESCENDING', limit })
      .catch(() => []);
    return docs.map((d) => d.data);
  }

  async getUsage(): Promise<UsageSnapshot> {
    type U = { search?: Partial<Record<SearchProviderId, { credits?: number }>> };
    const [day, month] = await Promise.all([
      this.usageDb.get<U>(`${this.base}/usage/${dayKey()}`).catch(() => null),
      this.usageDb.get<U>(`${this.base}/usage/${monthKey()}`).catch(() => null),
    ]);
    const pick = (u: U | undefined): ProviderCount => ({
      serpapi: u?.search?.serpapi?.credits ?? 0,
      tavily: u?.search?.tavily?.credits ?? 0,
    });
    return { day: pick(day?.data), month: pick(month?.data) };
  }

  async record(events: UsageEvent[]): Promise<void> {
    if (!events.length) return;
    const inc: Record<string, number> = {};
    const add = (k: string, n: number) => (inc[k] = (inc[k] ?? 0) + n);
    for (const e of events) {
      const field = e.type === 'request' ? 'requests' : e.type;
      add(fieldPath('search', e.provider, field), 1);
      if (e.credits) add(fieldPath('search', e.provider, 'credits'), e.credits);
    }
    const day = dayKey();
    const writes: Write[] = [
      { op: 'increment', path: `${this.base}/usage/${day}`, data: { date: day, updatedAt: SERVER_TIME }, increments: inc },
      {
        op: 'increment',
        path: `${this.base}/usage/${monthKey()}`,
        data: { month: day.slice(0, 7), updatedAt: SERVER_TIME },
        increments: inc,
      },
    ];
    await this.usageDb.commit(writes).catch((err) => {
      console.warn('[search] usage write failed', err instanceof Error ? err.message : err);
    });
  }
}

/** In-memory store for tests and local experiments. */
export class MemorySearchStore implements SearchStore {
  cache = new Map<string, CacheEntry>();
  usage: UsageSnapshot = { day: empty(), month: empty() };
  events: UsageEvent[] = [];
  async getCache(key: string) {
    return this.cache.get(key) ?? null;
  }
  async putCache(key: string, entry: CacheEntry) {
    this.cache.set(key, entry);
  }
  async recentCache(limit: number) {
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async getUsage() {
    return structuredClone(this.usage);
  }
  async record(events: UsageEvent[]) {
    for (const e of events) {
      this.events.push(e);
      this.usage.day[e.provider] += e.credits;
      this.usage.month[e.provider] += e.credits;
    }
  }
}
