/**
 * Pictures created by Atlas AI: loading, downloading and deleting.
 *
 * Metadata: users/{uid}/generatedImages/{id}; image bytes: users/{uid}/generatedImageData/{id}_{n}
 * (written by the server only; the owner can read and delete them, see firestore.rules).
 */
import { collection, doc, getDoc, getDocs, query, where, writeBatch, type Bytes, type Timestamp } from 'firebase/firestore';
import type { GeneratedImageInfo } from '@shared/types';
import { db } from '@/lib/firebase';

export interface StoredImage extends GeneratedImageInfo {
  conversationId: string;
  messageId: string;
  bytes: number;
  chunks: number;
  status: 'ready';
  createdAt?: Timestamp | null;
}

export const imagePaths = {
  images: (uid: string) => collection(db, 'users', uid, 'generatedImages'),
  image: (uid: string, id: string) => doc(db, 'users', uid, 'generatedImages', id),
  chunk: (uid: string, id: string, n: number) => doc(db, 'users', uid, 'generatedImageData', `${id}_${n}`),
};

/* Images already in this tab: just created (kept even if the server could not store them) or loaded once. */
const cache = new Map<string, Blob>();
const loading = new Map<string, Promise<Blob>>();

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',', 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Keep a just-created image in memory, so it shows and downloads without another read. */
export function rememberImage(id: string, dataUrl: string) {
  if (!cache.has(id)) cache.set(id, dataUrlToBlob(dataUrl));
}

export function cachedImage(id: string): Blob | undefined {
  return cache.get(id);
}

export class ImageGoneError extends Error {}

/** The original image (full quality) as a Blob. */
export function loadImageBlob(uid: string, id: string): Promise<Blob> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = loading.get(id);
  if (pending) return pending;
  const p = (async () => {
    const meta = await getDoc(imagePaths.image(uid, id));
    if (!meta.exists()) throw new ImageGoneError('This image was deleted.');
    const m = meta.data() as StoredImage;
    const parts = await Promise.all(Array.from({ length: m.chunks }, (_, n) => getDoc(imagePaths.chunk(uid, id, n))));
    if (parts.some((s) => !s.exists())) throw new ImageGoneError('This image is incomplete or was deleted.');
    const arrays = parts.map((s) => (s.data()!.data as Bytes).toUint8Array());
    const size = arrays.reduce((a, b) => a + b.length, 0);
    if (m.bytes && size !== m.bytes) throw new Error('The image data is incomplete.');
    const blob = new Blob(arrays.map((a) => new Uint8Array(a)), { type: m.mime || 'image/jpeg' });
    cache.set(id, blob);
    return blob;
  })().finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** atlas-image-20261108-1432-a-lion-in-a-forest.jpg */
export function imageFileName(info: Pick<GeneratedImageInfo, 'prompt' | 'mime'>, when = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  const slug =
    info.prompt
      .toLowerCase()
      .replace(/^(please\s+)?(generate|create|make|draw|design|render|paint|sketch|illustrate|produce)\s+(me\s+)?((a|an|the)\s+)?((realistic|professional)\s+)?((image|picture|photo|photograph|illustration|drawing|painting)\s+of\s+)?/i, '')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join('-')
      .slice(0, 48) || 'image';
  return `atlas-image-${stamp}-${slug}.${EXT[info.mime] ?? 'jpg'}`;
}

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Save the original file. Desktop and Android: a real download with the proper
 * file name. iPhone/iPad: the share sheet with the file itself ("Save Image" /
 * "Save to Files"), which also works in the installed app, where Safari's
 * download prompt is not available; the link download is the fallback.
 */
export async function downloadImage(blob: Blob, info: Pick<GeneratedImageInfo, 'prompt' | 'mime'>, when?: Date): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const name = imageFileName(info, when);
  const file = new File([blob], name, { type: blob.type || info.mime });
  if (isIOS() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return 'cancelled';
      // not allowed here: fall through to the download link
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // give the browser time to start reading the file before releasing it
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}

/** Delete an image: its metadata and every data chunk. The message that showed it is kept. */
export async function deleteImage(uid: string, id: string): Promise<void> {
  const meta = await getDoc(imagePaths.image(uid, id));
  const chunks = meta.exists() ? Math.max(1, Number((meta.data() as StoredImage).chunks) || 1) : 4;
  const batch = writeBatch(db);
  for (let n = 0; n < chunks; n++) batch.delete(imagePaths.chunk(uid, id, n));
  batch.delete(imagePaths.image(uid, id));
  await batch.commit();
  cache.delete(id);
}

/** Delete every image of a conversation (used when the conversation is deleted on this device). */
export async function deleteConversationImagesLocal(uid: string, conversationId: string): Promise<void> {
  const snap = await getDocs(query(imagePaths.images(uid), where('conversationId', '==', conversationId)));
  for (const d of snap.docs) await deleteImage(uid, d.id);
}
