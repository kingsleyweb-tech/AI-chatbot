/**
 * Hybrid knowledge retrieval: keyword (BM25-style over stored terms) and
 * semantic (int8 vectors) scores merged with reciprocal rank fusion, then a
 * relevance gate so unrelated knowledge is never injected.
 *
 * Access control happens before ranking: only sources the caller can read
 * (Firestore rules, enforced with the caller's token) and that may be sent to
 * an AI provider (not confidential, or explicitly authorized) are considered.
 */
import { embed } from '../embeddings.js';
import type { Firestore } from '../firestore.js';
import { estimateTokens } from '../docs/chunk.js';
import type { Source } from '../shared/types.js';
import { aiAllowed, kbBase, SHARD_SIZE, sourcePath, type KbChunk, type KbIndexShard, type KbScope, type KbSource } from './store.js';
import { cosinePacked, keywordScores, terms, unpackVector } from './text.js';

/** Minimum cosine for a chunk to count as relevant (gemini-embedding-001, measured). */
export const SEM_MIN = 0.62;
/** Cosine at which a match is strong enough to answer "do we know about X". */
export const SEM_STRONG = 0.7;
const MAX_CHUNKS = 12;
const RRF_K = 60;

export interface KnowledgeContext {
  text: string;
  sources: Source[];
  /** a strong match was found (used to skip an entity web search) */
  hit: boolean;
  /** sources considered */
  searched: number;
}

interface LoadedSource {
  id: string;
  scope: KbScope;
  base: string;
  data: KbSource;
  collection: string;
}

interface Candidate {
  src: LoadedSource;
  index: number;
  terms: string[];
  vector?: Float32Array;
  model?: string | null;
}

// Index shards are immutable per indexedAt, so they can be cached per instance.
const shardCache = new Map<string, KbIndexShard | null>();
function cacheSet(k: string, v: KbIndexShard | null) {
  if (shardCache.size > 400) shardCache.delete(shardCache.keys().next().value!);
  shardCache.set(k, v);
}

async function listScope(db: Firestore, scope: KbScope, uid: string): Promise<LoadedSource[]> {
  const base = kbBase(scope, uid);
  const [sources, collections] = await Promise.all([
    db.list<KbSource>(`${base}/kbSources`, { where: [['status', 'EQUAL', 'ready']], limit: 300 }),
    db.list<{ name?: string }>(`${base}/kbCollections`, { limit: 200 }),
  ]).catch(() => [[], []] as const);
  const names = new Map(collections.map((c) => [c.id, c.data.name ?? 'Collection']));
  return sources
    .filter((s) => names.has(s.data.collectionId) && aiAllowed(s.data))
    .map((s) => ({ id: s.id, scope, base, data: s.data, collection: names.get(s.data.collectionId)! }));
}

async function loadShards(db: Firestore, src: LoadedSource): Promise<KbIndexShard[]> {
  const n = Math.ceil((src.data.chunkCount ?? 0) / SHARD_SIZE);
  const out = await Promise.all(
    Array.from({ length: n }, async (_, s) => {
      const path = `${sourcePath(src.base, src.id)}/index/s${s}`;
      const key = `${path}@${src.data.indexedAt ?? ''}`;
      if (shardCache.has(key)) return shardCache.get(key)!;
      const doc = await db.get<KbIndexShard>(path).catch(() => null);
      cacheSet(key, doc?.data ?? null);
      return doc?.data ?? null;
    }),
  );
  return out.filter((s): s is KbIndexShard => Boolean(s));
}

/** Does the question name this source? ("summarize the Soko Aerial deck") */
function namesSource(queryTerms: Set<string>, title: string): boolean {
  const t = terms(title.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ')).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  return t.length > 0 && t.length <= 8 && t.every((w) => queryTerms.has(w));
}

export async function retrieveKnowledge(args: {
  db: Firestore;
  uid: string;
  query: { text: string; vector?: number[] | null; model?: string | null };
  budgetTokens: number;
  sourceOffset: number;
  /** include admin-managed shared collections (default true) */
  includeShared?: boolean;
}): Promise<KnowledgeContext | null> {
  const { db, uid } = args;
  const sources = (
    await Promise.all([listScope(db, 'personal', uid), args.includeShared === false ? [] : listScope(db, 'shared', uid)])
  ).flat();
  if (!sources.length) return null;

  const candidates: Candidate[] = [];
  await Promise.all(
    sources.map(async (src) => {
      for (const shard of await loadShards(db, src)) {
        shard.terms.forEach((t, i) =>
          candidates.push({
            src,
            index: shard.start + i,
            terms: t ? t.split(' ') : [],
            vector: shard.vectors?.[i] ? unpackVector(shard.vectors[i]) : undefined,
            model: shard.model,
          }),
        );
      }
    }),
  );
  if (!candidates.length) return { text: '', sources: [], hit: false, searched: sources.length };

  // ---- scores ----
  const qTerms = terms(args.query.text);
  const qSet = new Set(qTerms);
  const kw = keywordScores(qTerms, candidates.map((c) => c.terms));
  const maxKw = keywordScores(qTerms, [qTerms])[0] || 1;
  const models = [...new Set(candidates.map((c) => c.model).filter((m): m is string => Boolean(m)))];
  const qVecs = new Map<string, Float32Array>();
  await Promise.all(
    models.map(async (m) => {
      const v = args.query.model === m && args.query.vector ? args.query.vector : (await embed([args.query.text], m).catch(() => null))?.vectors[0];
      if (v) qVecs.set(m, Float32Array.from(v));
    }),
  );
  const sem = candidates.map((c) => (c.vector && c.model && qVecs.has(c.model) ? cosinePacked(c.vector, qVecs.get(c.model)!) : 0));

  const rankOf = (scores: number[], keep: (i: number) => boolean) => {
    const order = scores.map((s, i) => [s, i] as const).filter(([s, i]) => s > 0 && keep(i)).sort((a, b) => b[0] - a[0]);
    const r = new Map<number, number>();
    order.forEach(([, i], k) => r.set(i, k + 1));
    return r;
  };
  const kwCoverage = kw.map((s) => s / maxKw);
  const relevant = (i: number) => sem[i] >= SEM_MIN || kwCoverage[i] >= 0.6;
  const semRank = rankOf(sem, (i) => sem[i] >= SEM_MIN);
  const kwRank = rankOf(kw, (i) => kwCoverage[i] >= 0.34);
  const fused = candidates
    .map((_, i) => ({ i, score: (semRank.has(i) ? 1 / (RRF_K + semRank.get(i)!) : 0) + (kwRank.has(i) ? 1 / (RRF_K + kwRank.get(i)!) : 0) }))
    .filter((x) => x.score > 0 && relevant(x.i))
    .sort((a, b) => b.score - a.score);
  // strong = semantically close, or most of the question's distinct terms appear in one chunk
  const qDistinct = [...qSet];
  const share = (i: number) => {
    const s = new Set(candidates[i].terms);
    const present = qDistinct.filter((t) => s.has(t)).length;
    return present >= 2 ? present / qDistinct.length : 0;
  };
  const hit = fused.some(({ i }) => sem[i] >= SEM_STRONG || share(i) >= 0.75);

  // ---- selection within budget ----
  const picked: Candidate[] = [];
  let used = 0;
  const approx = (c: Candidate) => Math.min(600, Math.ceil(((c.src.data.charCount ?? 0) / Math.max(1, c.src.data.chunkCount ?? 1)) / 4));
  // a source the question names explicitly is read in full when it fits
  for (const src of sources) {
    if (!namesSource(qSet, src.data.title)) continue;
    const size = Math.ceil((src.data.charCount ?? 0) / 4);
    if (size > args.budgetTokens * 0.7 - used) continue;
    for (const c of candidates) if (c.src === src) picked.push(c);
    used += size;
  }
  for (const { i } of fused) {
    if (picked.length >= MAX_CHUNKS + 40) break;
    const c = candidates[i];
    if (picked.includes(c)) continue;
    if (picked.filter((p) => !namesSource(qSet, p.src.data.title)).length >= MAX_CHUNKS) break;
    if (used + approx(c) > args.budgetTokens) continue;
    picked.push(c);
    used += approx(c);
  }
  if (!picked.length) return { text: '', sources: [], hit: false, searched: sources.length };

  // ---- fetch the chosen chunks ----
  const texts = await Promise.all(
    picked.map((c) =>
      db
        .get<KbChunk>(`${sourcePath(c.src.base, c.src.id)}/chunks/${String(c.index).padStart(4, '0')}`)
        .then((d) => d?.data ?? null)
        .catch(() => null),
    ),
  );
  const rows = picked
    .map((c, k) => ({ c, chunk: texts[k] }))
    .filter((r): r is { c: Candidate; chunk: KbChunk } => Boolean(r.chunk))
    // keep each source's chunks together and in document order
    .sort((a, b) => (a.c.src.id === b.c.src.id ? a.c.index - b.c.index : picked.indexOf(a.c) - picked.indexOf(b.c)));

  const out: Source[] = [];
  const blocks: string[] = [];
  let budgetLeft = args.budgetTokens;
  for (const { c, chunk } of rows) {
    const t = estimateTokens(chunk.text);
    if (t > budgetLeft) continue;
    budgetLeft -= t;
    const n = args.sourceOffset + out.length + 1;
    const d = c.src.data;
    out.push({
      index: n,
      kind: 'knowledge',
      title: `${d.title} · ${chunk.ref}`,
      url: d.type === 'url' && d.url ? d.url : '',
      site: `${c.src.collection}${c.src.scope === 'shared' ? ' (shared)' : ''}`,
      snippet: chunk.text.slice(0, 220),
      ...(d.indexedAt ? { indexedAt: d.indexedAt } : {}),
    });
    blocks.push(
      `[K${n}] ${c.src.collection} › ${d.title} (${chunk.ref})${d.type === 'url' && d.url ? ` · ${d.url}` : ''}${d.indexedAt ? ` · indexed ${d.indexedAt.slice(0, 10)}` : ''}\n${chunk.text}`,
    );
  }
  return { text: blocks.join('\n\n'), sources: out, hit, searched: sources.length };
}
