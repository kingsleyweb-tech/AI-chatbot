/**
 * News retrieval monitoring (server identity only; clients cannot read these):
 *
 *   newsStats/{yyyy-mm-dd}   counters for one UTC day: requests, articles discovered / kept / rejected
 *                            as too old / undated / re-dated / duplicates, windows widened, failures,
 *                            and per source: ok / empty / failed counts and total response time
 *   newsFeeds/{feedId}       health of each publisher feed: last success, last error, entries, time
 *   config/newsFeeds         administrator changes to the feed registry (added, disabled, re-enabled)
 *
 * Only what actually happened is counted; nothing is estimated. No message text, user ids or
 * queries are stored here.
 */
import { trustedDb } from '../admin.js';
import { utcDay } from '../cloudflare/budget.js';
import { SERVER_TIME, type Firestore, type Write } from '../firestore.js';
import type { NewsResult } from './discover.js';
import { DEFAULT_FEEDS, type FeedDef, type Tier } from './sources.js';

export const FEEDS_CONFIG = 'config/newsFeeds';

export async function recordNews(userDb: Firestore, n: NewsResult): Promise<void> {
  const db = await trustedDb(userDb);
  const day = utcDay(n.retrievedAt);
  const inc: Record<string, number> = {
    requests: 1,
    discovered: n.stats.discovered,
    inWindow: n.stats.inWindow,
    rejectedOld: n.stats.rejectedOld,
    undated: n.stats.undated,
    redated: n.stats.redated,
    duplicates: n.stats.duplicates,
    irrelevant: n.stats.irrelevant,
    stories: n.stories.length,
    expanded: n.expanded ? 1 : 0,
    failures: n.failure && !n.stories.length ? 1 : 0,
  };
  for (const p of n.providers) {
    if (p.status === 'skipped') continue;
    inc[`sources.${p.id}.${p.status}`] = 1;
    if (p.id !== 'rss') {
      if (p.cached) inc[`sources.${p.id}.cached`] = 1;
      else if (p.ms != null) {
        inc[`sources.${p.id}.ms`] = p.ms;
        inc[`sources.${p.id}.timed`] = 1;
      }
    }
  }
  const writes: Write[] = [{ op: 'increment', path: `newsStats/${day}`, increments: inc, data: { day, updatedAt: SERVER_TIME } }];
  for (const fr of n.feeds) {
    if (fr.cached) continue; // only real reads say anything about a feed's health
    writes.push({
      op: 'set',
      path: `newsFeeds/${fr.feed.id}`,
      merge: true,
      data: fr.ok
        ? { id: fr.feed.id, lastOkAt: n.retrievedAt, lastItems: fr.items.length, lastMs: fr.ms, lastError: null, checkedAt: n.retrievedAt }
        : { id: fr.feed.id, lastErrorAt: n.retrievedAt, lastError: fr.error ?? 'failed', lastMs: fr.ms, checkedAt: n.retrievedAt },
    });
    writes.push({ op: 'increment', path: `newsFeeds/${fr.feed.id}`, increments: fr.ok ? { reads: 1 } : { reads: 1, failures: 1 } });
  }
  await db.commit(writes);
}

/* ------------------------------ feed registry (admin) ------------------------------ */

export interface FeedConfig {
  /** ids of default feeds an administrator switched off, with the reason */
  disabled: Record<string, string>;
  /** ids of default feeds an administrator switched on despite a default "disabled" note */
  enabled: string[];
  /** feeds added by administrators */
  custom: FeedDef[];
}

let feedCache: { at: number; feeds: FeedDef[]; config: FeedConfig } | null = null;
export function resetNewsFeedCache() {
  feedCache = null;
}

const TIERS: Tier[] = ['official', 'wire', 'specialist', 'regional', 'social', 'unknown'];

export function normalizeFeedConfig(raw: unknown): FeedConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const disabled: Record<string, string> = {};
  for (const [k, v] of Object.entries((r.disabled as Record<string, unknown>) ?? {})) if (/^[a-z0-9_]{2,40}$/.test(k)) disabled[k] = String(v ?? '').slice(0, 200) || 'Switched off by an administrator.';
  const enabled = Array.isArray(r.enabled) ? r.enabled.filter((x): x is string => typeof x === 'string' && /^[a-z0-9_]{2,40}$/.test(x)) : [];
  const custom = (Array.isArray(r.custom) ? r.custom : [])
    .map((c) => c as Partial<FeedDef>)
    .filter((c) => typeof c.id === 'string' && /^[a-z0-9_]{2,40}$/.test(c.id) && typeof c.url === 'string' && /^https:\/\//.test(c.url))
    .slice(0, 100)
    .map(
      (c): FeedDef => ({
        id: c.id!,
        name: String(c.name ?? c.id).slice(0, 80),
        url: c.url!.slice(0, 500),
        domain: String(c.domain ?? '').slice(0, 100),
        tier: TIERS.includes(c.tier as Tier) ? (c.tier as Tier) : 'unknown',
        topics: Array.isArray(c.topics) ? (c.topics.filter((t) => typeof t === 'string').slice(0, 6) as FeedDef['topics']) : ['general'],
        regions: Array.isArray(c.regions) ? c.regions.filter((t) => typeof t === 'string').slice(0, 6) : ['world'],
        ...(Array.isArray(c.entities) ? { entities: c.entities.filter((t) => typeof t === 'string').slice(0, 6) } : {}),
      }),
    );
  return { disabled, enabled, custom };
}

/** The feed registry in effect: defaults, with administrator changes applied. */
export async function loadFeeds(userDb: Firestore): Promise<{ feeds: FeedDef[]; config: FeedConfig }> {
  if (feedCache && Date.now() - feedCache.at < 60_000) return feedCache;
  let raw: unknown = null;
  try {
    raw = (await (await trustedDb(userDb)).get(FEEDS_CONFIG))?.data ?? null;
  } catch {
    // unreadable: defaults
  }
  const config = normalizeFeedConfig(raw);
  const feeds = [
    ...DEFAULT_FEEDS.map((f) => ({ ...f, disabled: config.disabled[f.id] ?? (config.enabled.includes(f.id) ? null : (f.disabled ?? null)) })),
    ...config.custom.filter((c) => !DEFAULT_FEEDS.some((d) => d.id === c.id)).map((c) => ({ ...c, disabled: config.disabled[c.id] ?? null })),
  ];
  feedCache = { at: Date.now(), feeds, config };
  return feedCache;
}

export async function saveFeedConfig(userDb: Firestore, config: FeedConfig, by: string): Promise<void> {
  const db = await trustedDb(userDb);
  await db.set(FEEDS_CONFIG, { ...normalizeFeedConfig(config), updatedAt: Date.now(), updatedBy: by });
  feedCache = null;
}

/* ------------------------------ admin view ------------------------------ */

export interface NewsAdminView {
  days: Record<string, unknown>[];
  feeds: (FeedDef & { builtIn: boolean; health: Record<string, unknown> | null })[];
}

export async function newsAdminView(userDb: Firestore, days = 7): Promise<NewsAdminView> {
  const db = await trustedDb(userDb);
  const [stats, health, { feeds }] = await Promise.all([
    db.list('newsStats', { orderBy: 'day', direction: 'DESCENDING', limit: days }).catch(() => []),
    db.list('newsFeeds', { limit: 300 }).catch(() => []),
    loadFeeds(userDb),
  ]);
  const byId = new Map(health.map((h) => [h.id.split('/').pop()!, h.data]));
  return {
    days: stats.map((s) => s.data),
    feeds: feeds.map((f) => ({ ...f, builtIn: DEFAULT_FEEDS.some((d) => d.id === f.id), health: byId.get(f.id) ?? null })),
  };
}
