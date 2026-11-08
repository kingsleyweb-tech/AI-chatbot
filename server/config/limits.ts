/**
 * Cost limits. Defaults are deliberately conservative; an admin can change
 * them in Settings > Usage, which writes Firestore `config/limits`.
 */
import type { Firestore } from '../firestore.js';
import type { SearchLimits } from '../shared/types.js';

export type { SearchLimits };

/**
 * Cloudflare's free allowance is 10,000 Neurons per day (resets 00:00 UTC). The app
 * stops below it, so it can never run into paid usage: the cap is clamped to
 * CLOUDFLARE_NEURON_CAP_MAX whatever an admin stores.
 */
export const CLOUDFLARE_FREE_NEURONS = 10_000;
export const CLOUDFLARE_NEURON_CAP_DEFAULT = 9_000;
export const CLOUDFLARE_NEURON_CAP_MAX = 9_500;

export const DEFAULT_LIMITS: SearchLimits = {
  serpapi: { daily: 8, monthly: 200 },
  tavily: { daily: 30, monthly: 900 },
  research: { maxSearches: 6, maxPageReads: 4 },
  cacheTtlHours: { live: 1, news: 2, general: 24, reference: 168 },
  /** the last N daily credits per provider are kept for searches the user explicitly asked for */
  autoReserve: 2,
  /** stop using a provider when its own reported remaining quota drops to this */
  providerReserve: 5,
  images: { perUserDaily: 10, appDailyNeurons: CLOUDFLARE_NEURON_CAP_DEFAULT },
};

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge a stored config over the defaults, clamping every value to a sane range. */
export function normalizeLimits(raw: unknown): SearchLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_LIMITS;
  return {
    serpapi: {
      daily: num(r.serpapi?.daily, d.serpapi.daily, 0, 10_000),
      monthly: num(r.serpapi?.monthly, d.serpapi.monthly, 0, 1_000_000),
    },
    tavily: {
      daily: num(r.tavily?.daily, d.tavily.daily, 0, 10_000),
      monthly: num(r.tavily?.monthly, d.tavily.monthly, 0, 1_000_000),
    },
    research: {
      maxSearches: num(r.research?.maxSearches, d.research.maxSearches, 1, 20),
      maxPageReads: num(r.research?.maxPageReads, d.research.maxPageReads, 0, 20),
    },
    cacheTtlHours: {
      live: num(r.cacheTtlHours?.live, d.cacheTtlHours.live, 0, 24),
      news: num(r.cacheTtlHours?.news, d.cacheTtlHours.news, 0, 720),
      general: num(r.cacheTtlHours?.general, d.cacheTtlHours.general, 0, 720),
      reference: num(r.cacheTtlHours?.reference, d.cacheTtlHours.reference, 0, 2160),
    },
    autoReserve: num((raw as Record<string, unknown> | null)?.autoReserve, d.autoReserve, 0, 1000),
    providerReserve: num((raw as Record<string, unknown> | null)?.providerReserve, d.providerReserve, 0, 1000),
    images: {
      perUserDaily: num(r.images?.perUserDaily, d.images.perUserDaily, 0, 100),
      appDailyNeurons: num(r.images?.appDailyNeurons, d.images.appDailyNeurons, 0, CLOUDFLARE_NEURON_CAP_MAX),
    },
  };
}

let cached: { value: SearchLimits; at: number } | null = null;

export async function loadLimits(db: Firestore): Promise<SearchLimits> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  let raw: unknown = null;
  try {
    raw = (await db.get('config/limits'))?.data ?? null;
  } catch {
    // rules not deployed yet, or transient error: fall back to defaults
  }
  const value = normalizeLimits(raw);
  cached = { value, at: Date.now() };
  return value;
}

export function invalidateLimits() {
  cached = null;
}
