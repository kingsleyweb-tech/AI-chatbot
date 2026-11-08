/**
 * Generated-image storage in Firestore.
 *
 * Firebase Storage is not enabled for this project (it needs the paid Blaze
 * plan), so image bytes are kept in Firestore, outside the message and the
 * metadata documents:
 *
 *   users/{uid}/generatedImages/{imageId}           metadata (no image data)
 *   users/{uid}/generatedImageData/{imageId}_{n}    image bytes (Firestore bytes value, <= 900 KB each)
 *
 * Both are written only by the server identity, in one atomic commit, and are
 * readable and deletable only by their owner (firestore.rules).
 */
import { trustedDb } from '../admin.js';
import { SERVER_TIME, type Firestore, type Write } from '../firestore.js';

/** Firestore documents are limited to 1 MiB; chunks stay well below it. */
export const CHUNK_BYTES = 900_000;

export interface GeneratedImageMeta {
  id: string;
  uid: string;
  conversationId: string;
  messageId: string;
  prompt: string;
  model: string;
  kind: 'generate' | 'edit';
  /** the image that was edited (a generated image's id), when kind is 'edit' */
  sourceImageId: string | null;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  chunks: number;
  /** how the browser retrieves the image: the chunk documents above */
  storage: 'firestore-chunks';
  status: 'ready';
}

export const metaPath = (uid: string, id: string) => `users/${uid}/generatedImages/${id}`;
export const chunkPath = (uid: string, id: string, n: number) => `users/${uid}/generatedImageData/${id}_${n}`;

export function splitChunks(bytes: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return out.length ? out : [new Uint8Array()];
}

export function imageWrites(meta: Omit<GeneratedImageMeta, 'chunks' | 'bytes' | 'storage' | 'status'>, bytes: Uint8Array): { writes: Write[]; meta: GeneratedImageMeta } {
  const parts = splitChunks(bytes);
  const full: GeneratedImageMeta = { ...meta, bytes: bytes.length, chunks: parts.length, storage: 'firestore-chunks', status: 'ready' };
  const writes: Write[] = parts.map((data, n) => ({
    op: 'set',
    path: chunkPath(meta.uid, meta.id, n),
    // fixed paths per image id: a retry rewrites the same documents, never a second copy
    data: { imageId: meta.id, n, data, createdAt: SERVER_TIME },
  }));
  // metadata last in the same commit: it only exists when every chunk does
  writes.push({ op: 'set', path: metaPath(meta.uid, meta.id), data: { ...full, createdAt: SERVER_TIME } });
  return { writes, meta: full };
}

/** Store an image (one atomic commit, retried once). Returns false if it could not be stored. */
export async function saveImage(
  userDb: Firestore,
  meta: Omit<GeneratedImageMeta, 'chunks' | 'bytes' | 'storage' | 'status'>,
  bytes: Uint8Array,
): Promise<{ ok: boolean; meta: GeneratedImageMeta }> {
  const { writes, meta: full } = imageWrites(meta, bytes);
  const db = await trustedDb(userDb);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // the same id and paths on retry: rewriting is idempotent, never a duplicate
      await db.commit(writes);
      return { ok: true, meta: full };
    } catch (err) {
      console.error(`[images] could not store image (attempt ${attempt + 1})`, err instanceof Error ? err.message : err);
    }
  }
  return { ok: false, meta: full };
}

/** Load a stored image's bytes (the owner's own database access is enough). */
export async function loadImage(db: Firestore, uid: string, id: string): Promise<{ meta: GeneratedImageMeta; bytes: Uint8Array } | null> {
  const doc = await db.get<GeneratedImageMeta>(metaPath(uid, id)).catch(() => null);
  if (!doc || doc.data.status !== 'ready') return null;
  const meta = doc.data;
  const chunks = await db.getMany<{ n: number; data: Uint8Array }>(Array.from({ length: meta.chunks }, (_, n) => chunkPath(uid, id, n))).catch(() => []);
  if (chunks.length !== meta.chunks || chunks.some((c) => !(c.data.data instanceof Uint8Array))) return null;
  const sorted = chunks.sort((a, b) => a.data.n - b.data.n);
  const bytes = new Uint8Array(meta.bytes);
  let off = 0;
  for (const c of sorted) {
    bytes.set(c.data.data, off);
    off += c.data.data.length;
  }
  return off === meta.bytes ? { meta, bytes } : null;
}

/** Delete images (metadata and every chunk). */
export function deleteImageWrites(uid: string, meta: Pick<GeneratedImageMeta, 'id' | 'chunks'>): Write[] {
  return [
    ...Array.from({ length: Math.max(1, meta.chunks || 1) }, (_, n) => ({ op: 'delete' as const, path: chunkPath(uid, meta.id, n) })),
    { op: 'delete' as const, path: metaPath(uid, meta.id) },
  ];
}
