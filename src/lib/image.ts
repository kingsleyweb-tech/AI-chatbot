import type { ImageAttachment } from '@shared/types';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
export const MAX_IMAGE_INPUT = 20 * 1024 * 1024;

/**
 * Downscale and re-encode an image so it is small enough to store in
 * Firestore and cheap to send to vision models (~150–400 KB).
 */
export async function compressImage(file: File, maxSide = 1600, quality = 0.82): Promise<ImageAttachment> {
  if (file.size > MAX_IMAGE_INPUT) throw new Error(`${file.name} is larger than 20 MB.`);
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if ('close' in bitmap) (bitmap as ImageBitmap).close();
  let q = quality;
  let dataUrl = canvas.toDataURL('image/jpeg', q);
  while (dataUrl.length > 900_000 && q > 0.4) {
    q -= 0.12;
    dataUrl = canvas.toDataURL('image/jpeg', q);
  }
  if (dataUrl.length > 1_200_000) throw new Error(`${file.name} is too detailed to attach. Try a smaller image.`);
  return { kind: 'image', name: file.name || 'image.jpg', mime: 'image/jpeg', dataUrl, width: w, height: h };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through (e.g. HEIC on some browsers) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(`${file.name}: this image format isn't supported by your browser.`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
