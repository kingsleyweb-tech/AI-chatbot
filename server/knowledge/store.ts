/**
 * Knowledge base storage and indexing.
 *
 * Layout (personal base = users/{uid}, shared base = kb/shared):
 *   {base}/kbCollections/{cid}                 name, description
 *   {base}/kbSources/{sid}                     metadata + status
 *   {base}/kbSources/{sid}/chunks/{0000}       chunk text + location
 *   {base}/kbSources/{sid}/index/{s0}          compact retrieval index for up to
 *                                              SHARD_SIZE chunks: keyword terms and
 *                                              int8 vectors (one read per shard)
 *
 * The server uses the caller's ID token, so Firestore rules decide who may
 * read or write each path, before anything is retrieved.
 */
import { embed } from '../embeddings.js';
import { SERVER_TIME, type Firestore, type Write } from '../firestore.js';
import { HttpError } from '../http.js';
import { chunkSections, type Section } from '../docs/chunk.js';
import { chunkTerms, cleanText, contentHash, packVector } from './text.js';

export type KbScope = 'personal' | 'shared';
export type KbSourceType = 'file' | 'url' | 'note';

export interface KbSource {
  collectionId: string;
  title: string;
  type: KbSourceType;
  fileName?: string;
  mime?: string;
  size?: number;
  url?: string;
  status: 'processing' | 'ready' | 'failed';
  error?: string | null;
  warning?: string | null;
  chunkCount?: number;
  charCount?: number;
  contentHash?: string;
  embeddingModel?: string | null;
  /** confidential sources are never sent to an AI provider unless aiAllowed */
  confidential?: boolean;
  aiAllowed?: boolean;
  addedFrom?: 'upload' | 'manual' | 'web_search';
  refreshDays?: number | null;
  indexedAt?: string;
  refreshedAt?: string;
}

export interface KbChunk {
  index: number;
  ref: string;
  text: string;
}

export interface KbIndexShard {
  shard: number;
  start: number;
  /** distinct terms per chunk, space separated */
  terms: string[];
  /** packed int8 vectors per chunk (absent for keyword-only sources) */
  vectors?: string[];
  model?: string | null;
}

export const SHARD_SIZE = 150;
export const KB_MAX_CHUNKS = 600;
export const KB_MAX_CHARS = 2_500_000;
export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 250;

export const kbBase = (scope: KbScope, uid: string) => (scope === 'shared' ? 'kb/shared' : `users/${uid}`);
export const sourcePath = (base: string, sid: string) => `${base}/kbSources/${sid}`;

/** May this source's text be sent to an external AI provider (embeddings, OCR, chat)? */
export const aiAllowed = (s: Pick<KbSource, 'confidential' | 'aiAllowed'>) => !s.confidential || s.aiAllowed === true;

export async function getSource(db: Firestore, base: string, sid: string): Promise<KbSource> {
  const doc = await db.get<KbSource>(sourcePath(base, sid));
  if (!doc) throw new HttpError(404, 'not_found', 'Knowledge source not found.');
  return doc.data;
}

/**
 * Clean, chunk, embed (when allowed) and store a source's text, replacing any
 * previous version. Stale chunks and index shards are removed in the same run.
 */
export async function indexSource(args: {
  db: Firestore;
  base: string;
  sourceId: string;
  sections: Section[];
  /** extra metadata to merge (title, url, warning ...) */
  meta?: Partial<KbSource>;
  now?: Date;
}): Promise<{ chunkCount: number; embedded: boolean; unchanged: boolean }> {
  const { db, base, sourceId } = args;
  const path = sourcePath(base, sourceId);
  const source = { ...(await getSource(db, base, sourceId)), ...args.meta };
  const now = (args.now ?? new Date()).toISOString();

  const sections = args.sections
    .map((s) => ({ ref: s.ref.slice(0, 200) || 'Text', text: cleanText(s.text) }))
    .filter((s) => s.text);
  const totalChars = sections.reduce((n, s) => n + s.text.length, 0);
  const fail = async (status: number, code: string, message: string) => {
    await db.set(path, { status: 'failed', error: message, updatedAt: SERVER_TIME }, true);
    throw new HttpError(status, code, message);
  };
  if (!totalChars) return fail(422, 'no_text', 'No readable text was found.');
  if (totalChars > KB_MAX_CHARS) return fail(413, 'too_large', 'This source is too large to index (max ~2.5M characters).');

  const hash = contentHash(sections);
  const useAi = aiAllowed(source);
  // Same content, already indexed with the right kind of index: only record the check.
  if (source.status === 'ready' && source.contentHash === hash && Boolean(source.embeddingModel) === useAi) {
    await db.set(path, { ...args.meta, refreshedAt: now, error: null, updatedAt: SERVER_TIME }, true);
    return { chunkCount: source.chunkCount ?? 0, embedded: Boolean(source.embeddingModel), unchanged: true };
  }

  const chunks = chunkSections(sections, CHUNK_SIZE, CHUNK_OVERLAP).slice(0, KB_MAX_CHUNKS);
  // Embedding sends text to an AI provider: never for confidential sources without authorization.
  const embedded = useAi ? await embed(chunks.map((c) => `${source.title}\n${c.ref}\n${c.text}`)) : null;

  const writes: Write[] = chunks.map((c) => ({
    op: 'set',
    path: `${path}/chunks/${String(c.index).padStart(4, '0')}`,
    data: { index: c.index, ref: c.ref, text: c.text },
  }));
  const shards = Math.ceil(chunks.length / SHARD_SIZE);
  for (let s = 0; s < shards; s++) {
    const part = chunks.slice(s * SHARD_SIZE, (s + 1) * SHARD_SIZE);
    const shard: KbIndexShard = {
      shard: s,
      start: s * SHARD_SIZE,
      // the title and location are searchable too
      terms: part.map((c) => chunkTerms(`${source.title} ${c.ref} ${c.text}`).join(' ')),
      ...(embedded ? { vectors: part.map((c) => packVector(embedded.vectors[c.index])), model: embedded.model } : { model: null }),
    };
    writes.push({ op: 'set', path: `${path}/index/s${s}`, data: shard });
  }

  // remove what the previous version had beyond the new size
  const prevChunks = source.chunkCount ?? 0;
  for (let i = chunks.length; i < prevChunks; i++) writes.push({ op: 'delete', path: `${path}/chunks/${String(i).padStart(4, '0')}` });
  for (let s = shards; s < Math.ceil(prevChunks / SHARD_SIZE); s++) writes.push({ op: 'delete', path: `${path}/index/s${s}` });

  const warnings = [args.meta?.warning ?? null];
  if (useAi && !embedded) warnings.push('Semantic index unavailable right now; keyword search only. Re-index later to add it.');
  if (!useAi) warnings.push('Confidential: indexed for keyword search only and never sent to an AI provider.');
  writes.push({
    op: 'set',
    path,
    data: {
      ...args.meta,
      status: 'ready',
      error: null,
      warning: warnings.filter(Boolean).join(' ') || null,
      chunkCount: chunks.length,
      charCount: totalChars,
      contentHash: hash,
      embeddingModel: embedded?.model ?? null,
      indexedAt: now,
      refreshedAt: now,
      updatedAt: SERVER_TIME,
    },
    merge: true,
  });
  await db.commit(writes);
  return { chunkCount: chunks.length, embedded: Boolean(embedded), unchanged: false };
}

/** Delete a source with all its chunks and index shards. */
export async function deleteSource(db: Firestore, base: string, sid: string): Promise<void> {
  const path = sourcePath(base, sid);
  const [chunks, shards] = await Promise.all([
    db.list(`${path}/chunks`, { limit: KB_MAX_CHUNKS + 50 }),
    db.list(`${path}/index`, { limit: 20 }),
  ]);
  await db.commit([...chunks, ...shards].map((d) => ({ op: 'delete' as const, path: d.path })).concat({ op: 'delete', path }));
}

/** Delete a collection and every source in it. */
export async function deleteCollection(db: Firestore, base: string, cid: string): Promise<number> {
  const sources = await db.list<KbSource>(`${base}/kbSources`, { where: [['collectionId', 'EQUAL', cid]], limit: 500 });
  for (const s of sources) await deleteSource(db, base, s.id);
  await db.delete(`${base}/kbCollections/${cid}`);
  return sources.length;
}
