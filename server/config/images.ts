/**
 * Cloudflare Workers AI image models. Request formats and costs were verified
 * with real calls (2026-11):
 *
 * - FLUX.2 [klein] 4B: multipart form (prompt, width, height, optional
 *   input_image_0..3 for editing); returns {result:{image: base64 JPEG}}.
 *   1024x1024 cost 104.2 Neurons; an edit with a 1024px input cost 109.6.
 *   Black Forest Labs partner model (zero data retention by the partner).
 * - FLUX.1 [schnell]: JSON {prompt, steps<=8}; 1024x1024 JPEG, 172.8 Neurons.
 *   Generation only.
 *
 * The estimate is what the app reserves against its daily Neuron cap before a
 * call; the exact cost (cf-ai-neurons header) is recorded afterwards.
 */
import { env } from '../env.js';

export interface ImageModel {
  id: string;
  label: string;
  /** Neurons reserved before a 1-megapixel call (rounded up from measured cost) */
  estNeurons: number;
  supportsEdit: boolean;
  request: 'multipart' | 'json';
  /** limits of the width/height parameters (pixels), when the model takes a size */
  size?: { min: number; max: number; step: number };
  terms: string;
}

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: '@cf/black-forest-labs/flux-2-klein-4b',
    label: 'FLUX.2 [klein] 4B',
    estNeurons: 130,
    supportsEdit: true,
    request: 'multipart',
    size: { min: 256, max: 1920, step: 16 },
    terms: 'https://bfl.ai/legal/terms-of-service',
  },
  {
    id: '@cf/black-forest-labs/flux-1-schnell',
    label: 'FLUX.1 [schnell]',
    estNeurons: 190,
    supportsEdit: false,
    request: 'json',
    terms: 'https://bfl.ai/legal/terms-of-service',
  },
];

export const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
/**
 * Tried once for a new picture when the main model is unavailable or errors (never for an edit:
 * FLUX.1 [schnell] cannot edit, and never for a picture the main model's filter blocked).
 */
export const BACKUP_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/** Safety classifier (verified: replies "safe" or "unsafe\nS<n>", about 9 Neurons). */
export const SAFETY_MODEL = '@cf/meta/llama-guard-3-8b';
export const SAFETY_EST_NEURONS = 15;

export function imageModel(id?: string): ImageModel {
  const wanted = id || env().cloudflareImageModel || DEFAULT_IMAGE_MODEL;
  return IMAGE_MODELS.find((m) => m.id === wanted) ?? IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL)!;
}

/** The model used for edits: the configured one if it can edit, else the default (which can). */
export function editModel(): ImageModel {
  const m = imageModel();
  return m.supportsEdit ? m : IMAGE_MODELS.find((x) => x.id === DEFAULT_IMAGE_MODEL)!;
}

export type AspectName = 'square' | 'landscape' | 'portrait';
export const ASPECTS: Record<AspectName, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1344 },
};

/** Aspect ratio from the wording of the request (square unless it asks otherwise). */
export function aspectFor(text: string): AspectName {
  const t = text.toLowerCase();
  if (/\b(9:16|portrait orientation|vertical|phone wallpaper|mobile wallpaper|story|stories|tall|poster|book cover)\b/.test(t)) return 'portrait';
  if (/\b(16:9|landscape orientation|horizontal|wide|widescreen|panoram\w*|banner|desktop wallpaper|wallpaper|cover photo|header|thumbnail)\b/.test(t)) return 'landscape';
  if (/\blandscapes?\b/.test(t)) return 'landscape';
  return 'square';
}
