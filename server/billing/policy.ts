/**
 * Free Models Only policy (server-side, applies to every AI call).
 *
 * Atlas AI never spends money on AI models:
 *  - OpenRouter: only ":free" model variants. Paid variants, routers such as
 *    openrouter/auto and paid embedding models are refused.
 *  - Gemini: only models listed as "Free of charge" on Google's Free Tier
 *    (verified against https://aistudio.google.com/docs/pricing, 2026-11),
 *    and only while GEMINI_BILLING is not "paid". The Google project must
 *    keep billing disabled; the app cannot see that setting itself.
 *  - Cloudflare Workers AI: curated models only, inside the free daily Neuron
 *    allowance (reserveNeurons, cloudflare/budget.ts). They run only where a
 *    reservation is made first (chat replies), never in background jobs.
 *  - ElevenLabs: the subscription's included credits only (elevenlabs/usage.ts).
 *
 * This module is the single check used by the provider registry before any
 * request leaves the server, so routing, fallbacks, background jobs
 * (titles, memory, summaries) and embeddings are all covered. An
 * administrator can narrow the approved list (config/billing), never widen
 * it past these rules.
 */
import { adminConfigured, adminDb } from '../admin.js';
import { CLOUDFLARE_CHAT_MODELS } from '../providers/cloudflare.js';
import { ProviderError } from '../providers/types.js';

/** Gemini models whose Free Tier is "Free of charge" (official pricing page, checked 2026-11). */
export const GEMINI_FREE_TIER = new Set([
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-embedding-001',
]);

export const BILLING_PATH = 'config/billing';
export const FREE_LIMIT_MESSAGE =
  'Atlas AI’s free AI usage limit has been reached for now. Please try again later.';

export function geminiBillingPaid(): boolean {
  return (process.env.GEMINI_BILLING ?? '').toLowerCase() === 'paid';
}

export type PolicyProvider = 'gemini' | 'cloudflare' | 'openrouter';
export function providerOfId(id: string): PolicyProvider {
  if (id.startsWith('gemini:')) return 'gemini';
  if (id.startsWith('@cf/')) return 'cloudflare';
  return 'openrouter';
}

/** Is this model free of charge under the policy (before any admin narrowing)? */
export function isFreeModelId(id: string): boolean {
  switch (providerOfId(id)) {
    case 'gemini':
      return !geminiBillingPaid() && GEMINI_FREE_TIER.has(id.slice('gemini:'.length));
    case 'cloudflare':
      return CLOUDFLARE_CHAT_MODELS.some((m) => m.id === id);
    default:
      // a vendor/model pair with the ":free" variant suffix; nothing else (no routers, no paid variants)
      return /^[a-z0-9][\w.-]*\/[\w.-]+:free$/i.test(id);
  }
}

/* ------------------------- administrator approved list ------------------------- */

export interface BillingSettings {
  /** null: every model the policy allows; otherwise only these (each must also pass the policy) */
  approvedModels: string[] | null;
  updatedAt?: number | null;
  updatedBy?: string | null;
}

let cache: { at: number; value: BillingSettings } | null = null;
const TTL_MS = 60_000;

export function normalizeBilling(raw: unknown): BillingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.approvedModels)
    ? [...new Set(r.approvedModels.filter((x): x is string => typeof x === 'string' && isFreeModelId(x)))]
    : null;
  return {
    approvedModels: list,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : null,
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : null,
  };
}

export async function loadBilling(fresh = false): Promise<BillingSettings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let raw: unknown = null;
  if (adminConfigured()) {
    try {
      raw = (await (await adminDb()).get(BILLING_PATH))?.data ?? null;
    } catch {
      // unreadable: keep the last known list (or the default) rather than fail every request
      if (cache) return cache.value;
    }
  }
  const value = normalizeBilling(raw);
  cache = { at: Date.now(), value };
  return value;
}

/** Save the approved list. Refuses any model the policy does not allow; it can only narrow. */
export async function saveBilling(approvedModels: string[] | null, by: string): Promise<BillingSettings> {
  if (approvedModels) {
    const bad = approvedModels.filter((id) => !isFreeModelId(id));
    if (bad.length)
      throw new ProviderError('bad_request', `Not free, so it cannot be approved: ${bad.slice(0, 3).join(', ')}`, 400);
  }
  const value: BillingSettings = {
    approvedModels: approvedModels ? [...new Set(approvedModels)].slice(0, 200) : null,
    updatedAt: Date.now(),
    updatedBy: by,
  };
  await (await adminDb()).set(BILLING_PATH, value);
  cache = { at: Date.now(), value };
  return value;
}

export function setBillingForTests(value: BillingSettings | null) {
  cache = value ? { at: Date.now() + 1e12, value } : null;
}

/** Allowed for chat and background completions: free under the policy and on the approved list. */
export function allowedBy(settings: BillingSettings, id: string): boolean {
  return isFreeModelId(id) && (settings.approvedModels === null || settings.approvedModels.includes(id));
}

function refused(id: string): ProviderError {
  return new ProviderError(
    'paid_blocked',
    `${id} is not an approved free model, so Atlas AI will not use it (free models only).`,
    403,
  );
}

/** Throws unless a chat/background completion on this model is allowed. */
export async function assertCompletionAllowed(id: string): Promise<void> {
  if (!allowedBy(await loadBilling(), id)) throw refused(id);
}

/**
 * Embeddings: free under the policy (the approved list is for chat models).
 * Cloudflare has no embedding path here.
 */
export function assertEmbeddingAllowed(id: string): void {
  if (!isFreeModelId(id) || providerOfId(id) === 'cloudflare') throw refused(id);
}
