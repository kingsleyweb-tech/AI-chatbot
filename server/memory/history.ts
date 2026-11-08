/**
 * Cross-conversation history index.
 *
 * Every completed exchange (user message + assistant reply) is appended to a
 * small searchable index under users/{uid}/convIndex/{shard}: the chat's
 * title, its project, a short excerpt of the exchange, its distinctive terms
 * and a compact embedding. Shards hold up to SHARD_MAX entries so a whole
 * history loads in a handful of reads.
 *
 * At answer time the index is searched with the same hybrid ranking as the
 * knowledge base (keyword + semantic, fused with reciprocal rank), so a
 * question like "What did we decide about Project Alpha?" finds the earlier
 * exchanges where it was discussed, even in other conversations. When a
 * project is in focus, only that project's entries are used.
 *
 * This index belongs to Atlas, not to a model: it works the same whichever
 * provider (Gemini, OpenRouter) answers.
 */
import { embed } from '../embeddings.js';
import type { Firestore, FsDoc } from '../firestore.js';
import { chunkTerms, cosinePacked, keywordScores, packVector, terms, unpackVector } from '../knowledge/text.js';

export interface IndexEntry {
  /** conversation id */
  c: string;
  /** position of the user message in the conversation (0-based) */
  k: number;
  /** conversation title at indexing time */
  t: string;
  /** project slug (projectMemory id) or null */
  p: string | null;
  /** epoch ms */
  at: number;
  /** excerpt: "User: ... / Atlas: ..." */
  x: string;
  /** distinctive terms, space separated */
  w: string;
  /** packed embedding of the excerpt (may be empty) */
  v: string;
  /** embedding model of v */
  m: string;
}

interface Shard {
  entries: IndexEntry[];
}

interface Meta {
  shard: number;
  size: number;
}

export interface HistoryHit {
  conversationId: string;
  title: string;
  at: number;
  excerpt: string;
  project: string | null;
  score: number;
}

export const SHARD_MAX = 120;
const MAX_SHARDS = 40;
const EXCERPT_USER = 700;
const EXCERPT_ASSISTANT = 800;
const SEM_MIN = 0.62;
const RRF_K = 60;

const shardId = (n: number) => `s${String(n).padStart(4, '0')}`;
const root = (uid: string) => `users/${uid}/convIndex`;

export function makeExcerpt(userText: string, assistantText: string): string {
  const clip = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  return `User: ${clip(userText, EXCERPT_USER)}\nAtlas: ${clip(assistantText, EXCERPT_ASSISTANT)}`;
}

/** Append one exchange to the index (optimistic concurrency, one retry). */
export async function indexExchange(args: {
  db: Firestore;
  uid: string;
  conversationId: string;
  position: number;
  title: string;
  project: string | null;
  userText: string;
  assistantText: string;
  now?: number;
  embedFn?: typeof embed;
}): Promise<void> {
  if (args.userText.trim().length < 4) return;
  const excerpt = makeExcerpt(args.userText, args.assistantText);
  const e = await (args.embedFn ?? embed)([`${args.title}\n${excerpt}`]).catch(() => null);
  const entry: IndexEntry = {
    c: args.conversationId,
    k: args.position,
    t: args.title.slice(0, 120),
    p: args.project,
    at: args.now ?? Date.now(),
    x: excerpt,
    w: chunkTerms(`${args.title} ${excerpt}`, 60).join(' '),
    v: e?.vectors[0] ? packVector(e.vectors[0]) : '',
    m: e?.vectors[0] ? e.model : '',
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const metaDoc = await args.db.get<Meta>(`${root(args.uid)}/meta`);
    let meta: Meta = metaDoc?.data ?? { shard: 0, size: 0 };
    const path = `${root(args.uid)}/${shardId(meta.shard)}`;
    const shard = await args.db.get<Shard>(path);
    let entries = (shard?.data.entries ?? []).filter((x) => !(x.c === entry.c && x.k === entry.k));
    let target = path;
    let precondition: { updateTime: string } | { exists: boolean } = shard?.updateTime ? { updateTime: shard.updateTime } : { exists: false };
    if (entries.length >= SHARD_MAX) {
      meta = { shard: meta.shard + 1, size: 0 };
      target = `${root(args.uid)}/${shardId(meta.shard)}`;
      entries = [];
      precondition = { exists: false };
    }
    entries.push(entry);
    try {
      await args.db.commit([
        { op: 'set', path: target, data: { entries }, precondition },
        { op: 'set', path: `${root(args.uid)}/meta`, data: { shard: meta.shard, size: entries.length } },
      ]);
      return;
    } catch (err) {
      if (attempt === 1 || !(err instanceof Error) || !/changed|conflict/i.test(err.message)) throw err;
    }
  }
}

export async function loadIndex(db: Firestore, uid: string): Promise<IndexEntry[]> {
  const docs = await db.list<Shard & Partial<Meta>>(root(uid), { limit: MAX_SHARDS + 1 });
  return docs.filter((d) => d.id !== 'meta').flatMap((d) => d.data.entries ?? []);
}

/**
 * Hybrid search over past exchanges. `exclude` filters out entries already
 * present verbatim in the context window (the current chat's recent turns).
 */
export async function searchHistory(args: {
  db: Firestore;
  uid: string;
  query: { text: string; vector?: number[] | null; model?: string | null };
  focusProject?: string | null;
  exclude?: (e: IndexEntry) => boolean;
  limit?: number;
  entries?: IndexEntry[];
  embedFn?: typeof embed;
}): Promise<HistoryHit[]> {
  const all = args.entries ?? (await loadIndex(args.db, args.uid));
  const candidates = all.filter((e) => !args.exclude?.(e) && (!args.focusProject || e.p === args.focusProject));
  if (!candidates.length) return [];

  const qTerms = terms(args.query.text);
  if (!qTerms.length) return [];
  const kw = keywordScores(qTerms, candidates.map((c) => (c.w ? c.w.split(' ') : [])));
  const maxKw = keywordScores(qTerms, [qTerms])[0] || 1;

  const models = [...new Set(candidates.map((c) => c.m).filter(Boolean))];
  const qVecs = new Map<string, Float32Array>();
  await Promise.all(
    models.map(async (m) => {
      const v =
        args.query.model === m && args.query.vector
          ? args.query.vector
          : (await (args.embedFn ?? embed)([args.query.text], m).catch(() => null))?.vectors[0];
      if (v) qVecs.set(m, Float32Array.from(v));
    }),
  );
  const sem = candidates.map((c) => (c.v && qVecs.has(c.m) ? cosinePacked(unpackVector(c.v), qVecs.get(c.m)!) : 0));

  const rankOf = (scores: number[], keep: (i: number) => boolean) => {
    const order = scores
      .map((s, i) => [s, i] as const)
      .filter(([s, i]) => s > 0 && keep(i))
      .sort((a, b) => b[0] - a[0]);
    const r = new Map<number, number>();
    order.forEach(([, i], k) => r.set(i, k + 1));
    return r;
  };
  const cov = kw.map((s) => s / maxKw);
  const semRank = rankOf(sem, (i) => sem[i] >= SEM_MIN);
  const kwRank = rankOf(kw, (i) => cov[i] >= 0.34);
  const fused = candidates
    .map((c, i) => ({
      c,
      score: (semRank.has(i) ? 1 / (RRF_K + semRank.get(i)!) : 0) + (kwRank.has(i) ? 1 / (RRF_K + kwRank.get(i)!) : 0),
      ok: sem[i] >= SEM_MIN || cov[i] >= 0.5,
    }))
    .filter((x) => x.score > 0 && x.ok)
    .sort((a, b) => b.score - a.score || b.c.at - a.c.at);

  // at most 2 excerpts per conversation so one long chat doesn't crowd out the rest
  const perConv = new Map<string, number>();
  const out: HistoryHit[] = [];
  for (const { c, score } of fused) {
    const n = perConv.get(c.c) ?? 0;
    if (n >= 2) continue;
    perConv.set(c.c, n + 1);
    out.push({ conversationId: c.c, title: c.t, at: c.at, excerpt: c.x, project: c.p, score });
    if (out.length >= (args.limit ?? 6)) break;
  }
  return out;
}

export function formatHistory(hits: HistoryHit[]): string {
  return hits
    .map((h) => `From "${h.title}" (${new Date(h.at).toISOString().slice(0, 10)}):\n${h.excerpt}`)
    .join('\n\n');
}

/** Remove a conversation's entries from every shard. */
export async function removeConversationFromIndex(db: Firestore, uid: string, conversationId: string): Promise<number> {
  const docs = await db.list<Shard>(root(uid), { limit: MAX_SHARDS + 1 });
  let removed = 0;
  for (const d of docs as FsDoc<Shard>[]) {
    if (d.id === 'meta' || !d.data.entries?.some((e) => e.c === conversationId)) continue;
    const entries = d.data.entries.filter((e) => e.c !== conversationId);
    removed += d.data.entries.length - entries.length;
    await db.commit([{ op: 'set', path: d.path, data: { entries }, precondition: d.updateTime ? { updateTime: d.updateTime } : undefined }]);
  }
  return removed;
}

/** Re-tag a conversation's entries with a project (when a chat turns out to be about one). */
export async function tagConversationProject(db: Firestore, uid: string, conversationId: string, project: string): Promise<void> {
  const docs = await db.list<Shard>(root(uid), { limit: MAX_SHARDS + 1 });
  for (const d of docs) {
    if (d.id === 'meta' || !d.data.entries?.some((e) => e.c === conversationId && e.p !== project)) continue;
    const entries = d.data.entries.map((e) => (e.c === conversationId && !e.p ? { ...e, p: project } : e));
    await db.commit([{ op: 'set', path: d.path, data: { entries }, precondition: d.updateTime ? { updateTime: d.updateTime } : undefined }]);
  }
}

/** Delete the whole index (clear-all history). */
export async function clearIndex(db: Firestore, uid: string): Promise<void> {
  const docs = await db.list(root(uid), { limit: MAX_SHARDS + 1 });
  if (docs.length) await db.commit(docs.map((d) => ({ op: 'delete' as const, path: d.path })));
}
