/**
 * Retrieval of VERIFIED central knowledge for answers. The verified set is loaded once per
 * instance (a few thousand small records), kept for a few minutes, and searched in memory with
 * keyword (BM25) and vector similarity: no paid vector service. Any change through the admin
 * actions invalidates the cache on that instance; other instances refresh within minutes.
 *
 * This is an additional source: when it finds nothing, is switched off or fails, answers carry on
 * exactly as before.
 */
import type { Firestore } from '../firestore.js';
import { cosinePacked, keywordScores, terms as textTerms, unpackVector } from '../knowledge/text.js';
import type { Source } from '../shared/types.js';
import { screenPii } from './screen.js';
import { bump, centralDb, hash, loadConfig, RECORDS, TOPICS } from './store.js';
import type { KRecord } from './types.js';

const TTL_MS = 3 * 60_000;
/** semantic similarity that counts as a match (same scale as the personal knowledge base) */
const SEM_MIN = 0.66;
const MAX_RECORDS = 3;
const MAX_CHARS = 4500;

interface Loaded {
  id: string;
  title: string;
  content: string;
  terms: string[];
  vector: Float32Array | null;
  model: string | null;
  source: { url: string; publisher: string } | null;
  verifiedAt: number | null;
  confidence: number;
}

let cache: { at: number; rows: Loaded[] } | null = null;
export function invalidateCentralCache() {
  cache = null;
}

async function verified(db: Firestore): Promise<Loaded[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await db.list<KRecord>(RECORDS, { where: [['status', 'EQUAL', 'VERIFIED']], limit: 5000 });
  const loaded = rows.map((r) => {
    const best = [...(r.data.sources ?? [])].filter((s) => s.reachable !== false).sort((a, b) => (a.tier === 'official' ? -1 : 0) - (b.tier === 'official' ? -1 : 0))[0];
    return {
      id: r.id,
      title: r.data.title,
      content: r.data.content,
      terms: r.data.terms ? r.data.terms.split(' ') : [],
      vector: r.data.vector ? unpackVector(r.data.vector) : null,
      model: r.data.vectorModel,
      source: best ? { url: best.url, publisher: best.publisher } : null,
      verifiedAt: r.data.verifiedAt,
      confidence: r.data.confidence,
    };
  });
  cache = { at: Date.now(), rows: loaded };
  return loaded;
}

export interface CentralContext {
  text: string;
  sources: Source[];
  ids: string[];
}

export function rankVerified(rows: Loaded[], query: { text: string; vector?: number[] | null; model?: string | null }): { row: Loaded; score: number }[] {
  const q = [...new Set(textTerms(query.text))];
  if (!q.length || !rows.length) return [];
  const kw = keywordScores(q, rows.map((r) => r.terms));
  const maxKw = Math.max(...kw, 0);
  const qv = query.vector?.length ? Float32Array.from(query.vector) : null;
  const out: { row: Loaded; score: number }[] = [];
  rows.forEach((row, i) => {
    const matched = q.filter((t) => row.terms.includes(t)).length / q.length;
    const sem = qv && row.vector && row.model === query.model ? cosinePacked(row.vector, qv) : null;
    // a keyword match must cover most of the question; a semantic match must be clearly close
    const kwOk = q.length >= 2 && matched >= 0.6 && kw[i] > 0;
    const semOk = sem != null && sem >= SEM_MIN;
    if (!kwOk && !semOk) return;
    const score = (sem ?? 0) * 0.6 + (maxKw ? kw[i] / maxKw : 0) * 0.3 + matched * 0.1;
    out.push({ row, score });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RECORDS);
}

export async function retrieveCentral(args: { db: Firestore; query: { text: string; vector?: number[] | null; model?: string | null }; sourceOffset: number }): Promise<CentralContext | null> {
  const db = await centralDb(args.db);
  const cfg = await loadConfig(db);
  if (!cfg.retrievalEnabled) return null;
  const ranked = rankVerified(await verified(db), args.query);
  if (!ranked.length) return null;
  const blocks: string[] = [];
  const sources: Source[] = [];
  let used = 0;
  for (const { row } of ranked) {
    const body = row.content.slice(0, Math.max(0, MAX_CHARS - used));
    if (body.length < 40) break;
    used += body.length;
    const n = args.sourceOffset + sources.length + 1;
    const verifiedOn = row.verifiedAt ? new Date(row.verifiedAt).toISOString().slice(0, 10) : 'unknown';
    blocks.push(`[K${n}] ${row.title} (verified ${verifiedOn}; source: ${row.source?.publisher ?? 'not recorded'})\n${body}`);
    sources.push({
      index: n,
      title: row.title,
      url: row.source?.url ?? '',
      snippet: body.slice(0, 200),
      kind: 'knowledge',
      site: 'Atlas verified knowledge',
      ...(row.verifiedAt ? { indexedAt: new Date(row.verifiedAt).toISOString() } : {}),
    });
  }
  if (!sources.length) return null;
  await bump(db, { retrievals: 1, retrievedRecords: sources.length }).catch(() => undefined);
  return { text: blocks.join('\n\n'), sources, ids: ranked.map((r) => r.row.id) };
}

/* ------------------------------ topic insights (opt-in) ------------------------------ */

const TOPIC_STOP = new Set('what when where which who whom whose why how does did can could would should will tell explain please about give list show find need want know help make with from into that this there their they them your yours mine thanks thank hello'.split(' '));

/**
 * The three most telling keywords of a question, or null when the question is too personal or
 * too short to aggregate safely. No question text and no user id is ever stored.
 */
export function topicKey(text: string): string[] | null {
  if (text.length > 600) return null;
  const pii = screenPii(text);
  if (pii.redacted.length || pii.blocked.length) return null;
  if (/\b(my|me|i|i'm|i've|mine|our|we)\b/i.test(text) && /\b(account|password|address|phone|salary|health|diagnos|pregnan|debt|loan|bank|lawyer|divorce)\b/i.test(text)) return null;
  const t = [...new Set(textTerms(text))].filter((w) => w.length >= 4 && !TOPIC_STOP.has(w) && !/\d/.test(w));
  if (t.length < 2) return null;
  return t.slice(0, 3).sort();
}

/** Count a question topic (when enabled), and whether verified knowledge covered it. */
export async function recordTopic(userDb: Firestore, text: string, covered: boolean): Promise<void> {
  const db = await centralDb(userDb);
  const cfg = await loadConfig(db);
  if (!cfg.topicInsights) return;
  const key = topicKey(text);
  if (!key) return;
  await db.commit([{ op: 'increment', path: `${TOPICS}/${hash(key.join(' '))}`, increments: covered ? { count: 1, covered: 1 } : { count: 1, misses: 1 }, data: { terms: key, lastAt: Date.now() } }]);
}
