/**
 * Admin AI settings (Firestore `config/ai`, edited in Settings > Usage by an
 * admin). Missing or invalid values fall back to safe defaults: Gemini first,
 * automatic fallback to the other provider for recoverable failures, and
 * paid models only with the user's approval (that rule is not configurable).
 */
import type { Firestore } from '../firestore.js';
import type { AiConfig } from '../shared/types.js';

export const DEFAULT_AI_CONFIG: AiConfig = {
  preferredProvider: 'gemini',
  defaultModel: null,
  fallback: 'any',
};

const MODEL_ID = /^[\w.:/-]{1,120}$/;

export function normalizeAiConfig(raw: unknown): AiConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AI_CONFIG;
  return {
    preferredProvider:
      r.preferredProvider === 'openrouter' || r.preferredProvider === 'gemini' || r.preferredProvider === 'cloudflare' ? r.preferredProvider : d.preferredProvider,
    defaultModel: typeof r.defaultModel === 'string' && MODEL_ID.test(r.defaultModel) ? r.defaultModel : d.defaultModel,
    fallback: r.fallback === 'off' || r.fallback === 'same_provider' || r.fallback === 'any' ? r.fallback : d.fallback,
  };
}

let cached: { value: AiConfig; at: number } | null = null;

export async function loadAiConfig(db: Firestore): Promise<AiConfig> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  let raw: unknown = null;
  try {
    raw = (await db.get('config/ai'))?.data ?? null;
  } catch {
    // rules not deployed yet, or transient error: defaults
  }
  const value = normalizeAiConfig(raw);
  cached = { value, at: Date.now() };
  return value;
}

export function invalidateAiConfig() {
  cached = null;
}
