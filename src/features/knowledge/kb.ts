import { collection, deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { api, ApiError } from '@/lib/api';
import { detectKind, extractText, MAX_DOC_BYTES } from '@/lib/extract';
import { db } from '@/lib/firebase';
import type { KbScope, Source } from '@/lib/types';
import { newId } from '@/lib/utils';

/**
 * Knowledge base (client half). Files are read in the browser (text never
 * needs the original file on the server); /api/knowledge cleans, chunks,
 * embeds and indexes it, reads web pages, and deletes sources with their index.
 */

const MAX_PAYLOAD_CHARS = 2_400_000;

export const SUGGESTED_COLLECTIONS = [
  'General Knowledge',
  'Companies and Organizations',
  'Technology and Programming',
  'Cybersecurity',
  'Research and Education',
  'Personal Knowledge',
];

const base = (scope: KbScope, uid: string) => (scope === 'shared' ? ['kb', 'shared'] : ['users', uid]);

export const kbPaths = {
  collections: (scope: KbScope, uid: string) => collection(db, ...(base(scope, uid) as [string, string]), 'kbCollections'),
  collection: (scope: KbScope, uid: string, id: string) => doc(db, ...(base(scope, uid) as [string, string]), 'kbCollections', id),
  sources: (scope: KbScope, uid: string) => collection(db, ...(base(scope, uid) as [string, string]), 'kbSources'),
  source: (scope: KbScope, uid: string, id: string) => doc(db, ...(base(scope, uid) as [string, string]), 'kbSources', id),
};

export async function createCollection(scope: KbScope, uid: string, name: string, description = ''): Promise<string> {
  const id = newId();
  await setDoc(kbPaths.collection(scope, uid, id), {
    name: name.trim().slice(0, 100) || 'Untitled',
    description: description.trim().slice(0, 500),
    createdAt: serverTimestamp(),
  });
  return id;
}

export async function renameCollection(scope: KbScope, uid: string, id: string, name: string, description?: string) {
  await updateDoc(kbPaths.collection(scope, uid, id), {
    name: name.trim().slice(0, 100) || 'Untitled',
    ...(description !== undefined ? { description: description.trim().slice(0, 500) } : {}),
  });
}

/** Deletes the collection's sources (with their chunks and index) on the server, then the collection. */
export async function deleteCollection(scope: KbScope, uid: string, id: string) {
  await api('knowledge', { json: { action: 'deleteCollection', scope, collectionId: id } });
  await deleteDoc(kbPaths.collection(scope, uid, id));
}

export async function deleteSource(scope: KbScope, sourceId: string) {
  await api('knowledge', { json: { action: 'deleteSource', scope, sourceId } });
}

async function sendSections(scope: KbScope, sourceId: string, sections: { ref: string; text: string }[], warning?: string | null) {
  let total = 0;
  const out: typeof sections = [];
  let truncated = false;
  for (const s of sections) {
    if (total >= MAX_PAYLOAD_CHARS) {
      truncated = true;
      break;
    }
    const text = s.text.slice(0, MAX_PAYLOAD_CHARS - total);
    if (text.length < s.text.length) truncated = true;
    out.push({ ref: s.ref.slice(0, 200), text });
    total += text.length;
  }
  if (!total) throw new Error('No readable text was found.');
  const note = [warning, truncated ? 'Only the first part of this very large source was indexed.' : null].filter(Boolean).join(' ');
  return api<{ chunkCount: number; embedded: boolean; unchanged: boolean }>('knowledge', {
    json: { action: 'index', scope, sourceId, sections: out, warning: note || null },
  });
}

async function markFailed(scope: KbScope, uid: string, sourceId: string, err: unknown) {
  const message = err instanceof ApiError || err instanceof Error ? err.message : 'Indexing failed.';
  await updateDoc(kbPaths.source(scope, uid, sourceId), { status: 'failed', error: message.slice(0, 300) }).catch(() => undefined);
}

export function validateFile(file: File) {
  if (file.size > MAX_DOC_BYTES) throw new Error(`${file.name} is larger than 25 MB.`);
  if (detectKind(file) === 'unsupported') throw new Error(`${file.name}: unsupported file type. Use PDF, DOCX, PPTX, XLSX, CSV, TXT or Markdown.`);
}

/**
 * Add a file, or replace an existing file source's content (same id, so
 * answers keep citing the same source and stale chunks are removed).
 */
export async function addFile(
  scope: KbScope,
  uid: string,
  file: File,
  opts: { collectionId: string; confidential: boolean; replaceId?: string },
): Promise<string> {
  validateFile(file);
  const id = opts.replaceId ?? newId();
  const meta = {
    title: file.name.slice(0, 300),
    fileName: file.name.slice(0, 300),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    status: 'processing',
    error: null,
    updatedAt: serverTimestamp(),
  };
  if (opts.replaceId) await updateDoc(kbPaths.source(scope, uid, id), meta);
  else {
    await setDoc(kbPaths.source(scope, uid, id), {
      ...meta,
      collectionId: opts.collectionId,
      type: 'file',
      confidential: opts.confidential,
      aiAllowed: false,
      addedFrom: 'upload',
      createdAt: serverTimestamp(),
    });
  }
  void (async () => {
    try {
      const r = await extractText(file);
      await sendSections(scope, id, r.sections, r.warning);
    } catch (err) {
      await markFailed(scope, uid, id, err);
    }
  })();
  return id;
}

/** A manual entry typed in the app. Editing a note re-indexes it under the same id. */
export async function saveNote(
  scope: KbScope,
  uid: string,
  opts: { collectionId: string; title: string; text: string; confidential: boolean; id?: string },
): Promise<string> {
  const id = opts.id ?? newId();
  const title = opts.title.trim().slice(0, 300) || 'Untitled note';
  if (opts.id) await updateDoc(kbPaths.source(scope, uid, id), { title, noteText: opts.text.slice(0, 100_000), status: 'processing', error: null, updatedAt: serverTimestamp() });
  else {
    await setDoc(kbPaths.source(scope, uid, id), {
      collectionId: opts.collectionId,
      title,
      noteText: opts.text.slice(0, 100_000),
      type: 'note',
      status: 'processing',
      error: null,
      confidential: opts.confidential,
      aiAllowed: false,
      addedFrom: 'manual',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  try {
    await sendSections(scope, id, [{ ref: 'Note', text: `${title}\n\n${opts.text}` }]);
  } catch (err) {
    await markFailed(scope, uid, id, err);
    throw err;
  }
  return id;
}

export async function addUrl(
  scope: KbScope,
  opts: { collectionId: string; url: string; refreshDays?: number | null; viaTavily?: boolean; addedFrom?: 'manual' | 'web_search' },
) {
  return api<{ sourceId: string; existed: boolean; unchanged: boolean; chunkCount: number; via: 'direct' | 'tavily' }>('knowledge', {
    json: { action: 'addUrl', scope, ...opts },
  });
}

export async function refreshSource(scope: KbScope, sourceId: string, viaTavily = false) {
  return api<{ unchanged: boolean; chunkCount: number }>('knowledge', { json: { action: 'refresh', scope, sourceId, viaTavily } });
}

/** Allow or stop sending a confidential source to the AI provider, then rebuild its index accordingly. */
export async function setAiAllowed(scope: KbScope, uid: string, sourceId: string, allowed: boolean) {
  await updateDoc(kbPaths.source(scope, uid, sourceId), { aiAllowed: allowed });
  await refreshSource(scope, sourceId);
}

export async function searchKnowledge(query: string) {
  return api<{ results: Source[]; strong: boolean; searched: number }>('knowledge', { json: { action: 'search', query } });
}

/** A URL source whose refresh interval has passed. */
export function isDue(s: { type: string; refreshDays?: number | null; indexedAt?: string; refreshedAt?: string; status: string }, now = Date.now()) {
  if (s.type !== 'url' || !s.refreshDays || s.status === 'processing') return false;
  const last = Math.max(Date.parse(s.refreshedAt ?? '') || 0, Date.parse(s.indexedAt ?? '') || 0);
  return !last || now - last > s.refreshDays * 86_400_000;
}
