/**
 * One image request, end to end: per-user limits -> app-wide Neuron budget ->
 * safety check -> Cloudflare image model -> storage. Used by the chat engine
 * when a message asks for an image (server/images/intent.ts).
 *
 * Retries never duplicate: the image id is derived from the reply's id, so a
 * retried reply reuses an image that was already stored (no second charge)
 * or overwrites the same documents.
 */
import { aspectFor, ASPECTS, BACKUP_IMAGE_MODEL, editModel, IMAGE_MODELS, imageModel, SAFETY_EST_NEURONS, SAFETY_MODEL, type ImageModel } from '../config/images.js';
import { imageSize, runImageModel, sniffImageMime } from '../cloudflare/client.js';
import { claimUserSlot, recordUsage, reserveNeurons } from '../cloudflare/budget.js';
import type { Firestore } from '../firestore.js';
import { ProviderError } from '../providers/types.js';
import type { ImageIntent } from './intent.js';
import { checkImagePrompt, defaultGuard } from './safety.js';
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
  /** each real stage; the size being made is passed once it is known */
  onStage: (stage: ImageStage, size?: { width: number; height: number }) => void;
  /** the request was already counted against the user's image allowance (server/usage) */
  allowanceChecked?: boolean;
}): Promise<ImageTurnResult> {
  const { db, uid, intent, signal } = args;
  const imageId = imageIdFor(args.messageId);

  // A retry of a reply whose image was already stored: reuse it (no new charge, no duplicate).
  const existing = await loadImage(db, uid, imageId).catch(() => null);
  if (existing && existing.meta.prompt === intent.prompt) {
    return { meta: existing.meta, stored: true, bytes: existing.bytes, neurons: 0, reused: true };
  }

  const slot = await claimUserSlot(db, uid, Date.now(), { allowanceChecked: args.allowanceChecked });
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
    args.onStage('checking', size);
    let safetyNeurons = 0;
    try {
      // the safety check runs on the reserved Cloudflare account (and moves with it)
      const safety = await checkImagePrompt(intent.prompt, { signal, guard: (p, s) => reservation.run(() => defaultGuard(p, s)) });
      safetyNeurons = safety.neurons;
      if (safetyNeurons) {
        await recordUsage(db, safetyNeurons, { uid, model: SAFETY_MODEL, type: 'safety', ok: true, account: reservation.account }).catch(() => undefined);
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
    args.onStage('generating', size);
    const kind = isEdit ? 'image_edit' : 'image_generate';
    let result: Awaited<ReturnType<typeof runImageModel>>;
    let usedModel = model;
    try {
      result = await reservation.run(() => runImageModel(model.id, buildRequest(model, intent.prompt, size, input), signal));
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : signal.aborted ? 'aborted' : 'internal';
      const flagged = providerFlagged(err);
      await reservation.settle((err as { neurons?: number }).neurons ?? 0, { uid, model: model.id, type: kind, ok: false, error: flagged ? 'provider_flagged' : code });
      if (flagged) throw flaggedError();
      // The main model is down: a new picture (never an edit) is tried once with the configured
      // backup, inside its own reservation. Edits need the main model, which can edit.
      const backup = backupImageModel(model);
      if (isEdit || !backup || signal.aborted || !(err instanceof ProviderError) || !BACKUP_ON.has(err.code)) throw err;
      const second = await reserveNeurons(db, backup.estNeurons);
      if (!second.ok) throw err;
      try {
        result = await second.run(() => runImageModel(backup.id, buildRequest(backup, intent.prompt, size), signal));
      } catch (err2) {
        const flagged2 = providerFlagged(err2);
        const code2 = err2 instanceof ProviderError ? err2.code : signal.aborted ? 'aborted' : 'internal';
        await second.settle((err2 as { neurons?: number }).neurons ?? 0, { uid, model: backup.id, type: kind, ok: false, error: flagged2 ? 'provider_flagged' : code2 });
        throw flagged2 ? flaggedError() : err2;
      }
      usedModel = backup;
      await second.settle(result.neurons, { uid, model: backup.id, type: kind, ok: true });
    }
    if (usedModel === model) await reservation.settle(result.neurons, { uid, model: model.id, type: kind, ok: true });

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
        model: usedModel.id,
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

/** Errors after which a new picture is tried once with the backup model. */
const BACKUP_ON = new Set(['model_unavailable', 'provider_error', 'timeout']);

/** The configured backup for generation (a different model), if any. */
function backupImageModel(primary: ImageModel): ImageModel | null {
  const b = IMAGE_MODELS.find((m) => m.id === BACKUP_IMAGE_MODEL);
  return b && b.id !== primary.id ? b : null;
}

function flaggedError(): ImageError {
  // The image model's own output filter (separate from Atlas AI's check). Retrying the same
  // prompt fails the same way, so this is a refusal with advice, not a retryable error.
  return new ImageError(
    'image_flagged',
    "Cloudflare's image model blocked this picture with its own safety filter. This often happens with brand names, logos, trademarked products or real people, even when the request is harmless.",
    false,
    'Try describing it without the brand or name, for example "a sleek modern electric sedan, silver, studio lighting".',
  );
}

/** The image model refused its own output (Cloudflare: "Your output has been flagged…"). */
export function providerFlagged(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.code !== 'bad_request') return false;
  return /flagged|nsfw|unsafe (content|output)|content (policy|filter)|safety (filter|system)|choose another prompt/i.test(err.message);
}
