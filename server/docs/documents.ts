import { embed, rank } from '../embeddings.js';
import { Firestore, SERVER_TIME, type Write } from '../firestore.js';
import { HttpError } from '../http.js';
import type { Source } from '../shared/types.js';
import { chunkSections, estimateTokens, type Section } from './chunk.js';

export interface DocumentMeta {
  name: string;
  mime: string;
  size: number;
  status: 'processing' | 'ready' | 'failed';
  error?: string | null;
  chunkCount?: number;
  charCount?: number;
  embeddingModel?: string | null;
}

interface ChunkDoc {
  index: number;
  ref: string;
  text: string;
  embedding?: number[];
  model?: string;
}

export const MAX_DOCUMENT_CHARS = 2_500_000;
export const MAX_CHUNKS = 600;

/** Chunk + embed extracted text and persist it under the document. */
export async function indexDocument(args: {
  db: Firestore;
  uid: string;
  documentId: string;
  sections: Section[];
}): Promise<{ chunkCount: number; embedded: boolean }> {
  const { db, uid, documentId } = args;
  const path = `users/${uid}/documents/${documentId}`;
  const meta = await db.get<DocumentMeta>(path);
  if (!meta) throw new HttpError(404, 'not_found', 'Document not found.');

  const totalChars = args.sections.reduce((n, s) => n + s.text.length, 0);
  if (totalChars === 0) {
    await db.set(path, { status: 'failed', error: 'No readable text was found in this file.', updatedAt: SERVER_TIME }, true);
    throw new HttpError(422, 'no_text', 'No readable text was found in this file.');
  }
  if (totalChars > MAX_DOCUMENT_CHARS) {
    await db.set(path, { status: 'failed', error: 'This document is too large to process.', updatedAt: SERVER_TIME }, true);
    throw new HttpError(413, 'too_large', 'This document is too large to process (max ~2.5M characters).');
  }

  const chunks = chunkSections(args.sections).slice(0, MAX_CHUNKS);
  const embedded = await embed(chunks.map((c) => c.text));
  const writes: Write[] = chunks.map((c, i) => ({
    op: 'set',
    path: `${path}/chunks/${String(c.index).padStart(4, '0')}`,
    data: {
      index: c.index,
      ref: c.ref,
      text: c.text,
      ...(embedded ? { embedding: embedded.vectors[i], model: embedded.model } : {}),
    },
  }));
  writes.push({
    op: 'set',
    path,
    data: {
      status: 'ready',
      error: null,
      chunkCount: chunks.length,
      charCount: totalChars,
      embeddingModel: embedded?.model ?? null,
      updatedAt: SERVER_TIME,
    },
    merge: true,
  });
  // Large commits are split by the client automatically.
  await db.commit(writes);
  return { chunkCount: chunks.length, embedded: Boolean(embedded) };
}

export interface DocContext {
  text: string;
  sources: Source[];
  failed: string[];
}

/**
 * Pick the document excerpts most relevant to the question. Small documents
 * are sent whole; large ones are retrieved chunk-by-chunk within a budget.
 */
export async function retrieveDocuments(args: {
  db: Firestore;
  uid: string;
  documentIds: string[];
  query: { text: string; vector?: number[] | null; model?: string | null };
  budgetTokens: number;
  sourceOffset: number;
}): Promise<DocContext> {
  const { db, uid } = args;
  const failed: string[] = [];
  const all: { doc: string; chunk: ChunkDoc }[] = [];
  const names = new Map<string, string>();
  await Promise.all(
    args.documentIds.slice(0, 8).map(async (id) => {
      const meta = await db.get<DocumentMeta>(`users/${uid}/documents/${id}`);
      if (!meta) return;
      names.set(id, meta.data.name);
      if (meta.data.status !== 'ready') {
        failed.push(`${meta.data.name} (${meta.data.status === 'failed' ? meta.data.error ?? 'extraction failed' : 'still processing'})`);
        return;
      }
      const chunks = await db.list<ChunkDoc>(`users/${uid}/documents/${id}/chunks`, {
        orderBy: 'index',
        limit: MAX_CHUNKS,
      });
      for (const c of chunks) all.push({ doc: id, chunk: c.data });
    }),
  );
  if (!all.length) return { text: '', sources: [], failed };

  const totalTokens = all.reduce((n, c) => n + estimateTokens(c.chunk.text), 0);
  let picked: typeof all;
  if (totalTokens <= args.budgetTokens) {
    picked = all;
  } else {
    const ranked = rank(all, args.query, (c) => ({
      text: c.chunk.text,
      vector: c.chunk.embedding,
      model: c.chunk.model,
    }));
    picked = [];
    let used = 0;
    // always include the opening chunk of each doc for orientation
    for (const id of names.keys()) {
      const first = all.find((c) => c.doc === id && c.chunk.index === 0);
      if (first && used + estimateTokens(first.chunk.text) < args.budgetTokens * 0.3) {
        picked.push(first);
        used += estimateTokens(first.chunk.text);
      }
    }
    for (const r of ranked) {
      if (picked.includes(r.item)) continue;
      const t = estimateTokens(r.item.chunk.text);
      if (used + t > args.budgetTokens) continue;
      picked.push(r.item);
      used += t;
    }
    picked.sort((a, b) => (a.doc === b.doc ? a.chunk.index - b.chunk.index : a.doc.localeCompare(b.doc)));
  }

  const sources: Source[] = [];
  const blocks = picked.map((p) => {
    const n = args.sourceOffset + sources.length + 1;
    const name = names.get(p.doc) ?? 'Document';
    sources.push({
      index: n,
      kind: 'document',
      title: `${name} · ${p.chunk.ref}`,
      url: '',
      snippet: p.chunk.text.slice(0, 220),
    });
    return `[D${n}] ${name} (${p.chunk.ref})\n${p.chunk.text}`;
  });
  return { text: blocks.join('\n\n'), sources, failed };
}
