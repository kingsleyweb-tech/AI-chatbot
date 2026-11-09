/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom reader without a dependency. Feeds are public and free; each is
 * read with a short timeout and a size cap, and kept in memory for a few minutes so a burst of
 * questions does not re-download the same feed.
 */
import { parseDate } from './dates.js';
import type { FeedDef } from './sources.js';

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  /** publisher's own publication time (ms) */
  published: number | null;
  /** publisher's update time (ms), when separate */
  updated: number | null;
}

export interface FeedResult {
  feed: FeedDef;
  ok: boolean;
  items: FeedItem[];
  ms: number;
  error?: string;
  cached?: boolean;
}

const MAX_BYTES = 1_500_000;
const MAX_ITEMS = 60;
export const FEED_TTL_MS = 10 * 60_000;
const UA = 'AtlasAI-News/1.0 (+https://chatatlasai.vercel.app)';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function unwrap(s: string): string {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : s;
}

/** Plain text from feed HTML: tags removed, entities decoded, whitespace collapsed. */
export function plainText(s: string): string {
  let t = unwrap(s);
  // escaped HTML inside a non-CDATA description ("&lt;p&gt;...")
  if (/&lt;\/?[a-z]/i.test(t)) t = decodeEntities(t);
  t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

function tag(block: string, names: string[]): string | null {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i');
    const m = block.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return null;
}

function linkOf(block: string): string | null {
  // Atom: <link rel="alternate" href="..."/> (or the first link without rel)
  const links = [...block.matchAll(/<link\b([^>]*)\/?>(?:([^<]*)<\/link>)?/gi)];
  for (const l of links) {
    const attrs = l[1];
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const rel = attrs.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href && (!rel || rel === 'alternate')) return decodeEntities(href.trim());
    const text = l[2] ? unwrap(l[2]).trim() : '';
    if (!href && /^https?:\/\//i.test(text)) return decodeEntities(text);
  }
  const guid = block.match(/<guid(?:\s[^>]*isPermaLink\s*=\s*["']true["'][^>]*|\s*)>([\s\S]*?)<\/guid>/i)?.[1];
  const g = guid ? unwrap(guid).trim() : '';
  return /^https?:\/\//i.test(g) ? decodeEntities(g) : null;
}

/** Parse feed XML into items. Exported for tests. */
export function parseFeed(xml: string, now = Date.now()): FeedItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const b of blocks.slice(0, MAX_ITEMS * 2)) {
    const title = plainText(tag(b, ['title']) ?? '');
    const url = linkOf(b);
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const pubRaw = tag(b, ['pubDate', 'published', 'dc:date', 'a10:published', 'issued', 'created']);
    const updRaw = tag(b, ['updated', 'a10:updated', 'atom:updated', 'modified', 'dc:modified', 'lastBuildDate']);
    let published = pubRaw ? parseDate(plainText(pubRaw), now) : null;
    const updated = updRaw ? parseDate(plainText(updRaw), now) : null;
    // Atom feeds that only carry <updated> (no <published>): treat it as the publication time only
    // when nothing better exists; the URL date check later catches re-dated old articles.
    if (published == null && updated != null && !pubRaw) published = updated;
    const summary = plainText(tag(b, ['description', 'summary', 'content:encoded', 'content']) ?? '').slice(0, 500);
    items.push({ title: title.slice(0, 300), url, summary, published, updated: updated !== published ? updated : null });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  void reader.cancel().catch(() => undefined);
  const buf = new Uint8Array(Math.min(size, MAX_BYTES));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, buf.length - o);
    buf.set(c.subarray(0, take), o);
    o += take;
    if (o >= buf.length) break;
  }
  return new TextDecoder('utf-8').decode(buf);
}

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
/** Tests: route feed requests through this fetch. */
export function setFeedFetch(f: Fetch | null) {
  fetchImpl = f;
  cache.clear();
}

const cache = new Map<string, { at: number; result: FeedResult }>();

export async function readFeed(feed: FeedDef, opts: { now?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FeedResult> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(feed.id);
  if (hit && Date.now() - hit.at < FEED_TTL_MS && hit.result.feed.url === feed.url) return { ...hit.result, cached: true };
  const t0 = Date.now();
  let result: FeedResult;
  try {
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 6_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 6_000);
    const res = await (fetchImpl ?? fetch)(feed.url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml;q=0.9' },
      redirect: 'follow',
      signal,
    });
    if (!res.ok) {
      result = { feed, ok: false, items: [], ms: Date.now() - t0, error: `HTTP ${res.status}` };
    } else {
      const items = parseFeed(await readCapped(res), now);
      result = items.length ? { feed, ok: true, items, ms: Date.now() - t0 } : { feed, ok: false, items: [], ms: Date.now() - t0, error: 'no entries' };
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    result = { feed, ok: false, items: [], ms: Date.now() - t0, error: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error' };
  }
  // failures are cached briefly too, so a dead feed is not retried on every question
  cache.set(feed.id, { at: result.ok ? Date.now() : Date.now() - FEED_TTL_MS + 2 * 60_000, result });
  return result;
}
