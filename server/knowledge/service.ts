/**
 * Knowledge base operations behind /api/knowledge. All Firestore access uses
 * the caller's token, so the rules decide what they may read and change
 * (personal collections: owner only; shared collections: admins write).
 */
import { loadLimits } from '../config/limits.js';
import { SERVER_TIME, type Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import type { Section } from '../docs/chunk.js';
import { searchService } from '../search/router.js';
import { FirestoreSearchStore } from '../search/store.js';
import { fetchPage } from './fetch.js';
import { retrieveKnowledge } from './retrieve.js';
import { deleteCollection, deleteSource, getSource, indexSource, kbBase, sourcePath, type KbScope, type KbSource } from './store.js';
import { cleanText, normalizeUrl, urlSourceId } from './text.js';

export interface KbCtx {
  db: Firestore;
  uid: string;
  admin: boolean;
}

function baseFor(ctx: KbCtx, scope: KbScope): string {
  if (scope === 'shared' && !ctx.admin) throw new HttpError(403, 'forbidden', 'Only administrators can change shared knowledge.');
  return kbBase(scope, ctx.uid);
}

/** Index text extracted in the browser (files) or typed in (notes). */
export async function indexText(ctx: KbCtx, a: { scope: KbScope; sourceId: string; sections: Section[]; warning?: string | null }) {
  const base = baseFor(ctx, a.scope);
  return indexSource({ db: ctx.db, base, sourceId: a.sourceId, sections: a.sections, meta: a.warning ? { warning: a.warning } : {} });
}

async function readPage(ctx: KbCtx, url: string, viaTavily: boolean): Promise<{ title: string; sections: Section[]; url: string; via: 'direct' | 'tavily' }> {
  let directError: unknown = null;
  try {
    const page = await fetchPage(url);
    const chars = page.sections.reduce((n, s) => n + s.text.length, 0);
    if (chars >= 300 || !viaTavily) return { ...page, via: 'direct' };
  } catch (err) {
    directError = err;
    if (!viaTavily) throw err;
  }
  // Pages that block bots or need JavaScript: Tavily reads them (1 credit per 5 pages, within budget).
  const ex = await searchService().extract({
    uid: ctx.uid,
    store: new FirestoreSearchStore(ctx.db, ctx.uid),
    limits: await loadLimits(ctx.db),
    urls: [url],
    priority: 'explicit',
  });
  if (!ex.ok || !ex.results[0]?.content) {
    if (directError) throw directError;
    throw new HttpError(502, 'fetch_failed', ex.ok ? 'The page has no readable text.' : ex.reason);
  }
  const r = ex.results[0];
  return { url: r.url || url, title: r.title || new URL(url).hostname, sections: [{ ref: 'Page', text: r.content }], via: 'tavily' };
}

/**
 * Add a web page (or a web finding the user approved) to a collection. The
 * id is derived from the URL, so adding the same page again refreshes it
 * instead of storing a duplicate.
 */
export async function addUrl(
  ctx: KbCtx,
  a: { scope: KbScope; collectionId: string; url: string; refreshDays?: number | null; viaTavily?: boolean; addedFrom?: KbSource['addedFrom'] },
) {
  const base = baseFor(ctx, a.scope);
  const url = normalizeUrl(a.url);
  const id = urlSourceId(url);
  const col = await ctx.db.get(`${base}/kbCollections/${a.collectionId}`);
  if (!col) throw new HttpError(404, 'not_found', 'Collection not found.');
  const existing = await ctx.db.get<KbSource>(sourcePath(base, id));
  if (existing && existing.data.collectionId !== a.collectionId) {
    const other = await ctx.db.get<{ name?: string }>(`${base}/kbCollections/${existing.data.collectionId}`);
    if (other) {
      throw new HttpError(409, 'duplicate', `This page is already in "${other.data.name ?? 'another collection'}". Refresh it there instead.`);
    }
  }
  if (!existing || existing.data.collectionId !== a.collectionId) {
    await ctx.db.set(sourcePath(base, id), {
      collectionId: a.collectionId,
      title: new URL(url).hostname,
      type: 'url',
      url,
      status: 'processing',
      error: null,
      confidential: false,
      addedFrom: a.addedFrom ?? 'manual',
      refreshDays: a.refreshDays ?? null,
      createdAt: SERVER_TIME,
      updatedAt: SERVER_TIME,
    });
  }
  return { sourceId: id, existed: Boolean(existing), ...(await refreshUrl(ctx, base, id, url, a.viaTavily ?? false, a.refreshDays)) };
}

async function refreshUrl(ctx: KbCtx, base: string, id: string, url: string, viaTavily: boolean, refreshDays?: number | null) {
  try {
    const page = await readPage(ctx, url, viaTavily);
    const r = await indexSource({
      db: ctx.db,
      base,
      sourceId: id,
      sections: page.sections,
      meta: {
        title: page.title.slice(0, 300),
        warning: page.via === 'tavily' ? 'Read with Tavily (the page could not be read directly).' : null,
        ...(refreshDays !== undefined ? { refreshDays } : {}),
      },
    });
    return { ...r, via: page.via };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'The page could not be read.';
    await ctx.db.set(sourcePath(base, id), { status: 'failed', error: message.slice(0, 300), updatedAt: SERVER_TIME }, true).catch(() => undefined);
    throw err;
  }
}

/** Re-read a URL source (or re-index a confidential source after authorization). */
export async function refresh(ctx: KbCtx, a: { scope: KbScope; sourceId: string; viaTavily?: boolean }) {
  const base = baseFor(ctx, a.scope);
  const s = await getSource(ctx.db, base, a.sourceId);
  if (s.type === 'url' && s.url) return refreshUrl(ctx, base, a.sourceId, s.url, a.viaTavily ?? false);
  // Files and notes: re-index the stored chunk text (e.g. after allowing AI access, to add embeddings).
  const chunks = await ctx.db.list<{ index: number; ref: string; text: string }>(`${sourcePath(base, a.sourceId)}/chunks`, { orderBy: 'index', limit: 700 });
  if (!chunks.length) throw new HttpError(409, 'reupload', 'Upload the file again to re-index it.');
  // chunks overlap; re-chunking the joined text keeps the content without doubling it
  const sections = mergeChunks(chunks.map((c) => c.data));
  return indexSource({ db: ctx.db, base, sourceId: a.sourceId, sections, meta: { contentHash: '' } as Partial<KbSource> });
}

/** Rebuild sections from overlapping chunks (drops the overlap). */
export function mergeChunks(chunks: { ref: string; text: string }[]): Section[] {
  const out: Section[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.ref === c.ref) {
      // find the overlap between the end of last and the start of c
      let k = Math.min(400, last.text.length, c.text.length);
      while (k > 20 && !last.text.endsWith(c.text.slice(0, k))) k--;
      last.text += (k > 20 ? c.text.slice(k) : '\n' + c.text);
    } else out.push({ ref: c.ref, text: c.text });
  }
  return out.map((s) => ({ ref: s.ref, text: cleanText(s.text) }));
}

export async function removeSource(ctx: KbCtx, a: { scope: KbScope; sourceId: string }) {
  await deleteSource(ctx.db, baseFor(ctx, a.scope), a.sourceId);
  return { deleted: true };
}

export async function removeCollection(ctx: KbCtx, a: { scope: KbScope; collectionId: string }) {
  return { deletedSources: await deleteCollection(ctx.db, baseFor(ctx, a.scope), a.collectionId) };
}

/** Search the knowledge base directly (Knowledge page search box). */
export async function search(ctx: KbCtx, a: { query: string }) {
  const r = await retrieveKnowledge({ db: ctx.db, uid: ctx.uid, query: { text: a.query }, budgetTokens: 6000, sourceOffset: 0 });
  return { results: r?.sources ?? [], strong: r?.hit ?? false, searched: r?.searched ?? 0 };
}
