/**
 * Persistence for the search service: the per-user result cache and the
 * per-provider usage counters. Firestore in production; in-memory in tests.
 */
import { createHash } from 'node:crypto';
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
}

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
}

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
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t && !STOP.has(t));
  const seen = new Set<string>();
  return tokens.filter((t) => (seen.has(t) ? false : (seen.add(t), true))).join(' ');
}

export function cacheKey(scope: string, normalized: string): string {
  return createHash('sha1').update(`${scope}|${normalized}`).digest('hex').slice(0, 32);
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export const monthKey = (d = new Date()) => `m-${d.toISOString().slice(0, 7)}`;

const empty = (): ProviderCount => ({ serpapi: 0, tavily: 0 });

export class FirestoreSearchStore implements SearchStore {
  constructor(
    private db: Firestore,
    private uid: string,
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

  async getUsage(): Promise<UsageSnapshot> {
    type U = { search?: Partial<Record<SearchProviderId, { credits?: number }>> };
    const [day, month] = await Promise.all([
      this.db.get<U>(`${this.base}/usage/${dayKey()}`).catch(() => null),
      this.db.get<U>(`${this.base}/usage/${monthKey()}`).catch(() => null),
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
    await this.db.commit(writes).catch((err) => {
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
