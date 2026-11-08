/**
 * One image request, end to end: per-user limits -> app-wide Neuron budget ->
 * safety check -> Cloudflare image model -> storage. Used by the chat engine
 * when a message asks for an image (server/images/intent.ts).
 *
 * Retries never duplicate: the image id is derived from the reply's id, so a
 * retried reply reuses an image that was already stored (no second charge)
 * or overwrites the same documents.
 */
import { aspectFor, ASPECTS, editModel, imageModel, SAFETY_EST_NEURONS, SAFETY_MODEL, type ImageModel } from '../config/images.js';
import { imageSize, runImageModel, sniffImageMime } from '../cloudflare/client.js';
import { claimUserSlot, recordUsage, reserveNeurons } from '../cloudflare/budget.js';
import type { Firestore } from '../firestore.js';
import { ProviderError } from '../providers/types.js';
import type { ImageIntent } from './intent.js';
import { checkImagePrompt } from './safety.js';
import { loadImage, saveImage, type GeneratedImageMeta } from './store.js';

export type ImageStage = 'checking' | 'generating' | 'saving';

/** A refusal or failure with a message meant for the user (never contains credentials). */
export class ImageError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public suggestion?: string,
  ) {
    super(message);
  }
}

export interface ImageTurnResult {
  meta: GeneratedImageMeta;
  /** false when storing failed: the browser keeps the image so it can still be downloaded */
  stored: boolean;
  bytes: Uint8Array;
  neurons: number;
  reused: boolean;
}

export const imageIdFor = (messageId: string) => `img_${messageId}`.slice(0, 140);

/** Fit a source picture inside the model's range, keeping its shape (multiples of 16). */
export function editSize(src: { width: number; height: number } | null, model: ImageModel): { width: number; height: number } {
  if (!src || !src.width || !src.height) return ASPECTS.square;
  const step = model.size?.step ?? 16;
  const max = Math.min(1024, model.size?.max ?? 1024);
  const min = model.size?.min ?? 256;
  const scale = max / Math.max(src.width, src.height);
  const fit = (v: number) => Math.max(min, Math.min(max, Math.round((v * scale) / step) * step));
  return { width: fit(src.width), height: fit(src.height) };
}

function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const bytes = Uint8Array.from(Buffer.from(m[1], 'base64'));
  return sniffImageMime(bytes) ? bytes : null;
}

function buildRequest(model: ImageModel, prompt: string, size: { width: number; height: number }, input?: Uint8Array) {
  if (model.request === 'json') return { json: { prompt, steps: 4 } };
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  if (input) form.append('input_image_0', new Blob([new Uint8Array(input)], { type: sniffImageMime(input) ?? 'image/jpeg' }), 'input.jpg');
  return { form };
}

export async function runImageTurn(args: {
  db: Firestore;
  uid: string;
  conversationId: string;
  messageId: string;
  intent: ImageIntent;
  /** the attached picture (data URL) for an edit of an attachment */
  attachment?: string | null;
  /** the conversation's last generated image, for a follow-up edit */
  previousImageId?: string | null;
  signal: AbortSignal;
  onStage: (stage: ImageStage) => void;
}): Promise<ImageTurnResult> {
  const { db, uid, intent, signal } = args;
  const imageId = imageIdFor(args.messageId);

  // A retry of a reply whose image was already stored: reuse it (no new charge, no duplicate).
  const existing = await loadImage(db, uid, imageId).catch(() => null);
  if (existing && existing.meta.prompt === intent.prompt) {
    return { meta: existing.meta, stored: true, bytes: existing.bytes, neurons: 0, reused: true };
  }

  const slot = await claimUserSlot(db, uid);
  if (!slot.ok) throw new ImageError(slot.reason === 'user_daily' ? 'image_daily_limit' : 'image_busy', slot.message, slot.reason !== 'user_daily');
  try {
    const isEdit = intent.kind === 'edit';
    const model = isEdit ? editModel() : imageModel();

    // ---- source picture for an edit ----
    let input: Uint8Array | undefined;
    let sourceImageId: string | null = null;
    if (isEdit) {
      if (intent.source === 'attachment') {
        input = args.attachment ? (decodeDataUrl(args.attachment) ?? undefined) : undefined;
        if (!input) throw new ImageError('image_input', 'The attached picture could not be read. Attach it again as a JPEG, PNG or WebP image.');
      } else {
        const prev = args.previousImageId ? await loadImage(db, uid, args.previousImageId).catch(() => null) : null;
        if (!prev) throw new ImageError('image_input', 'The previous image is no longer available (it may have been deleted), so it cannot be edited. Ask for a new image instead.');
        input = prev.bytes;
        sourceImageId = prev.meta.id;
      }
    }
    const inputSize = input ? imageSize(input) : null;
    const size = isEdit ? editSize(inputSize, model) : ASPECTS[aspectFor(intent.prompt)];
    // reserve enough for output + input pixels + the safety check
    const megapixels = (size.width * size.height) / 1_048_576 + (inputSize ? (inputSize.width * inputSize.height) / 1_048_576 : 0);
    const estimate = Math.ceil(model.estNeurons * Math.max(1, megapixels)) + SAFETY_EST_NEURONS;

    const reservation = await reserveNeurons(db, estimate);
    if (!reservation.ok) {
      throw new ImageError(
        reservation.reason === 'app_cap' ? 'image_allowance' : 'image_unavailable',
        reservation.message,
        false,
        reservation.reason === 'app_cap' ? 'You can keep chatting normally; only image creation is paused.' : undefined,
      );
    }

    // ---- safety ----
    args.onStage('checking');
    let safetyNeurons = 0;
    try {
      const safety = await checkImagePrompt(intent.prompt, { signal });
      safetyNeurons = safety.neurons;
      if (safetyNeurons) {
        await recordUsage(db, safetyNeurons, { uid, model: SAFETY_MODEL, type: 'safety', ok: true }).catch(() => undefined);
      }
      if (!safety.ok) {
        await reservation.settle(0, { uid, model: model.id, type: isEdit ? 'image_edit' : 'image_generate', ok: false, error: `blocked_${safety.category}` }).catch(() => undefined);
        throw new ImageError(safety.category === 'unavailable' ? 'image_safety_unavailable' : 'image_blocked', safety.message, safety.category === 'unavailable');
      }
    } catch (err) {
      if (err instanceof ImageError) throw err;
      await reservation.settle(0, { uid, model: model.id, type: isEdit ? 'image_edit' : 'image_generate', ok: false, error: 'aborted' }).catch(() => undefined);
      throw err;
    }

    // ---- generation ----
    args.onStage('generating');
    let result: Awaited<ReturnType<typeof runImageModel>>;
    try {
      result = await runImageModel(model.id, buildRequest(model, intent.prompt, size, input), signal);
    } catch (err) {
      const neurons = (err as { neurons?: number }).neurons ?? 0;
      const code = err instanceof ProviderError ? err.code : signal.aborted ? 'aborted' : 'internal';
      await reservation.settle(neurons, { uid, model: model.id, type: isEdit ? 'image_edit' : 'image_generate', ok: false, error: code });
      throw err;
    }
    await reservation.settle(result.neurons, { uid, model: model.id, type: isEdit ? 'image_edit' : 'image_generate', ok: true });

    // ---- storage ----
    args.onStage('saving');
    const dims = imageSize(result.bytes) ?? size;
    const saved = await saveImage(
      db,
      {
        id: imageId,
        uid,
        conversationId: args.conversationId,
        messageId: args.messageId,
        prompt: intent.prompt,
        model: model.id,
        kind: isEdit ? 'edit' : 'generate',
        sourceImageId,
        mime: result.mime,
        width: dims.width,
        height: dims.height,
      },
      result.bytes,
    );
    return { meta: saved.meta, stored: saved.ok, bytes: result.bytes, neurons: result.neurons + safetyNeurons, reused: false };
  } finally {
    slot.release();
  }
}
