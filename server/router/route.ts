/**
 * Capability-aware model routing.
 *
 * 1. Keep the selected model when it can handle the request.
 * 2. Otherwise use the best FREE model that can (task preferences first).
 * 3. If only a paid model can, ask the user first: nothing is spent until
 *    the client resends with that model explicitly approved.
 *
 * The selected/default model is never changed; a switch applies to one reply.
 */
import { modelConfig, TASK_PREFERENCES } from '../config/models.js';
import type { ModelInfo } from '../shared/types.js';
import type { Task } from './task.js';

export interface RouteOptions {
  paidAvailable: boolean | null;
  /** a paid model the user approved for this one request */
  approvedPaid?: string | null;
  maxChain?: number;
  /** provider ranked first among capable free models (admin setting, default gemini) */
  preferredProvider?: 'gemini' | 'openrouter' | 'cloudflare';
  /** automatic fallback policy (admin setting) */
  fallback?: 'any' | 'same_provider' | 'off';
}

export type RouteResult =
  | {
      kind: 'ok';
      chain: string[];
      /** set when the reply will not come from the selected model */
      switched: { from: string; to: string; reason: string } | null;
    }
  | {
      kind: 'approval';
      model: ModelInfo;
      reason: string;
      /** rough USD estimate for this request, from catalog pricing */
      estCost: number | null;
      /** the provider account has no credits, so approval alone is not enough */
      creditsNeeded: boolean;
    }
  | { kind: 'none'; reason: string };

export function estimateCost(m: ModelInfo, promptTokens: number, completionTokens = 1500): number | null {
  if (!m.pricing) return null;
  return +((promptTokens * m.pricing.prompt + completionTokens * m.pricing.completion) / 1e6).toFixed(5);
}

/** Why a model cannot serve this task (capability-wise), or null if it can. */
export function unfitReason(m: ModelInfo | undefined, task: Task): string | null {
  if (!m) return 'is not currently offered by the provider';
  if (!m.available) return 'is unavailable right now';
  if (task.needsVision && !m.capabilities.vision) return 'cannot read images';
  if (task.needsAudio && !m.capabilities.audioInput) return 'cannot process audio';
  if (m.contextLength && m.contextLength < task.estTokens) return 'has too small a context window for this message';
  return null;
}

function preferenceList(task: Task, selected?: ModelInfo): string[] {
  if (task.needsVision) return TASK_PREFERENCES.vision;
  if (selected?.contextLength && selected.contextLength < task.estTokens) return TASK_PREFERENCES.longContext;
  if (task.intent === 'code') return TASK_PREFERENCES.code;
  return TASK_PREFERENCES.general;
}

function rankCandidates(models: ModelInfo[], prefs: string[], preferred?: string): ModelInfo[] {
  const fallbacks = modelConfig().fallbackModels;
  const score = (m: ModelInfo) => {
    const p = prefs.indexOf(m.id);
    const f = fallbacks.indexOf(m.id);
    return [preferred && m.provider !== preferred ? 1 : 0, p === -1 ? 999 : p, f === -1 ? 999 : f, m.featured ? 0 : 1, -m.contextLength];
  };
  return [...models].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return a.id.localeCompare(b.id);
  });
}

/**
 * Which chain entry to try after a failure, or -1 to stop. Failures that hit a
 * whole provider (free daily cap, rejected key) skip to another provider, so
 * no request is wasted on models that cannot work. Non-recoverable errors
 * (bad request, content policy) never fall back.
 */
export function nextInChain(
  chain: string[],
  i: number,
  err: { code: string; fallbackable: boolean },
  providerOf: (id: string) => string,
): number {
  if (err.code === 'daily_limit' || err.code === 'invalid_key') {
    return chain.findIndex((id, j) => j > i && providerOf(id) !== providerOf(chain[i]));
  }
  return err.fallbackable && i < chain.length - 1 ? i + 1 : -1;
}

/** Apply the admin fallback policy to a chain (the first entry is always kept). */
export function applyFallbackPolicy(chain: string[], catalog: ModelInfo[], policy: RouteOptions['fallback'] = 'any'): string[] {
  if (policy === 'off') return chain.slice(0, 1);
  if (policy === 'same_provider') {
    const providerOf = (id: string) => catalog.find((m) => m.id === id)?.provider ?? (id.startsWith('gemini:') ? 'gemini' : id.startsWith('@cf/') ? 'cloudflare' : 'openrouter');
    const first = providerOf(chain[0]);
    return chain.filter((id) => providerOf(id) === first);
  }
  return chain;
}

export function routeModel(selectedId: string, task: Task, catalog: ModelInfo[], opts: RouteOptions): RouteResult {
  const r = routeInner(selectedId, task, catalog, opts);
  return r.kind === 'ok' && r.chain.length ? { ...r, chain: applyFallbackPolicy(r.chain, catalog, opts.fallback) } : r;
}

function routeInner(selectedId: string, task: Task, catalog: ModelInfo[], opts: RouteOptions): RouteResult {
  const maxChain = opts.maxChain ?? 4;
  if (!catalog.length) {
    // Catalog unavailable: fall back to the configured order and let the provider decide.
    const ids = [selectedId, ...modelConfig().fallbackModels.filter((m) => m !== selectedId)];
    return { kind: 'ok', chain: ids.slice(0, maxChain), switched: null };
  }
  const selected = catalog.find((m) => m.id === selectedId);
  const fits = (m: ModelInfo) => unfitReason(m, task) === null;
  const usable = (m: ModelInfo) =>
    m.free || m.id === opts.approvedPaid || (m.id === selectedId && opts.paidAvailable !== false);

  // Cloudflare models run when the user selects one, or when an admin makes Cloudflare the
  // preferred provider (then they are tried first, with Gemini/OpenRouter as fallbacks).
  // Otherwise they are never auto-picked and never a fallback.
  const auto = (m: ModelInfo) => m.provider !== 'cloudflare' || opts.preferredProvider === 'cloudflare';
  const freeFit = rankCandidates(catalog.filter((m) => m.free && auto(m) && fits(m)), preferenceList(task, selected), opts.preferredProvider);

  const approved = opts.approvedPaid ? catalog.find((m) => m.id === opts.approvedPaid) : undefined;
  if (approved && fits(approved)) {
    if (opts.paidAvailable === false && !approved.free) {
      return { kind: 'approval', model: approved, reason: 'This request needs a paid model.', estCost: estimateCost(approved, task.estTokens), creditsNeeded: true };
    }
    return { kind: 'ok', chain: [approved.id, ...freeFit.map((m) => m.id)].slice(0, maxChain), switched: approved.id === selectedId ? null : { from: selectedId, to: approved.id, reason: 'you approved a paid model for this request' } };
  }

  if (selected && fits(selected) && usable(selected)) {
    const rest = freeFit.filter((m) => m.id !== selected.id).map((m) => m.id);
    return { kind: 'ok', chain: [selected.id, ...rest].slice(0, maxChain), switched: null };
  }

  const reason =
    selected && fits(selected) && !usable(selected) ? 'needs OpenRouter credits' : (unfitReason(selected, task) ?? 'cannot handle this request');

  if (freeFit.length) {
    const chain = freeFit.map((m) => m.id).slice(0, maxChain);
    return { kind: 'ok', chain, switched: { from: selectedId, to: chain[0], reason } };
  }

  const paidFit = catalog
    .filter((m) => !m.free && auto(m) && fits(m))
    .sort((a, b) => Number(b.featured) - Number(a.featured) || (estimateCost(a, task.estTokens) ?? 1e9) - (estimateCost(b, task.estTokens) ?? 1e9));
  if (paidFit.length) {
    const model = paidFit[0];
    const what = task.needsVision ? 'read images' : task.needsAudio ? 'process audio' : 'handle a message this long';
    return {
      kind: 'approval',
      model,
      reason: `No free model available right now can ${what}. ${model.name} can, but it is a paid model.`,
      estCost: estimateCost(model, task.estTokens),
      creditsNeeded: opts.paidAvailable === false,
    };
  }
  return {
    kind: 'none',
    reason: task.needsVision ? 'None of the available models can read images.' : 'No available model can handle this request.',
  };
}
