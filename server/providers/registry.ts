import type { ModelCatalog, ModelInfo } from '../shared/types.js';
import { modelConfig } from '../config/models.js';
import {
  allowedBy,
  assertCompletionAllowed,
  assertEmbeddingAllowed,
  isFreeModelId,
  loadBilling,
} from '../billing/policy.js';
import { CLOUDFLARE_PREFIX, CloudflareProvider } from './cloudflare.js';
import { GEMINI_PREFIX, GeminiProvider } from './gemini.js';
import { freeDailyLimitActive, OpenRouterProvider } from './openrouter.js';
import { ProviderError, type ChatProvider } from './types.js';

/**
 * Wrap a provider with the Free Models Only policy: every completion, stream
 * and embedding is checked before any request leaves the server, whoever the
 * caller is (chat, fallbacks, titles, memory, summaries, knowledge).
 */
function guarded(p: ChatProvider): ChatProvider {
  return {
    id: p.id,
    isConfigured: () => p.isConfigured(),
    listModels: () => p.listModels(),
    async *stream(params) {
      await assertCompletionAllowed(params.model);
      yield* p.stream(params);
    },
    async complete(params) {
      await assertCompletionAllowed(params.model);
      // Background jobs make no Neuron reservation, so they never run on Cloudflare.
      if (p.id === 'cloudflare')
        throw new ProviderError('paid_blocked', 'Cloudflare models are used for chat replies only.', 403);
      return p.complete(params);
    },
    ...(p.embed
      ? {
          embed: async (model: string, inputs: string[], signal?: AbortSignal) => {
            assertEmbeddingAllowed(model);
            return p.embed!(model, inputs, signal);
          },
        }
      : {}),
  };
}

/**
 * Provider registry. Each provider owns a model-id prefix ("gemini:"); the
 * empty prefix (OpenRouter) catches everything else. One catalog, one router,
 * one conversation engine for all of them.
 */
const openrouter = new OpenRouterProvider();
const gemini = new GeminiProvider();
const cloudflare = new CloudflareProvider();
const providers: { prefix: string; provider: ChatProvider }[] = [
  { prefix: GEMINI_PREFIX, provider: guarded(gemini) },
  // selectable only: never picked automatically or used as a fallback (see router/route.ts)
  { prefix: CLOUDFLARE_PREFIX, provider: guarded(cloudflare) },
  { prefix: '', provider: guarded(openrouter) },
];

export function providerFor(modelId: string): ChatProvider {
  return providers.find((p) => modelId.startsWith(p.prefix))!.provider;
}

/** The provider that serves an embedding model id. */
export function embeddingProvider(model = ''): ChatProvider {
  return providerFor(model);
}

/** Models whose provider has a key configured (used to filter config lists). */
export function isModelConfigured(modelId: string): boolean {
  return providerFor(modelId).isConfigured();
}

export function configuredProviders(): string[] {
  return providers.filter((p) => p.provider.isConfigured()).map((p) => p.provider.id);
}

export async function getCatalog(): Promise<ModelCatalog> {
  const cfg = modelConfig();
  const all: ModelInfo[] = [];
  const lists = await Promise.all(
    providers
      .filter(({ provider }) => provider.isConfigured())
      .map(({ provider }) =>
        provider.listModels().catch((err) => {
          // one provider being down must not hide the others
          console.warn(`[catalog] ${provider.id} models unavailable: ${err instanceof Error ? err.message : err}`);
          return [] as ModelInfo[];
        }),
      ),
  );
  // Learn whether the free OpenRouter daily quota is used up (the answer about credits is ignored:
  // paid models are never offered, whatever the account holds).
  if (openrouter.isConfigured()) await openrouter.paidAvailable();
  const limited = freeDailyLimitActive();
  const billing = await loadBilling();
  for (const list of lists) {
    for (const m of list) {
      // Free Models Only: paid and unapproved models are not offered at all.
      if (!allowedBy(billing, m.id)) continue;
      // Free OpenRouter models are all blocked once the account-wide daily cap is hit.
      all.push(limited && m.provider === 'openrouter' ? { ...m, free: true, available: false } : { ...m, free: true });
    }
  }
  if (!all.length && !lists.length) throw new Error('No AI provider is configured.');
  const offered = (id: string) => allowedBy(billing, id) && (!all.length || all.some((m) => m.id === id));
  const fallbackModels = cfg.fallbackModels.filter(offered);
  return {
    models: all,
    defaultModel: offered(cfg.defaultModel) ? cfg.defaultModel : (fallbackModels[0] ?? all[0]?.id ?? cfg.defaultModel),
    fallbackModels,
    paidAvailable: false,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Every model the Free Models Only policy allows, whether or not an administrator approved it
 * (for the admin list). Paid models never appear, so they cannot be approved.
 */
export async function freeModelCandidates(): Promise<{ id: string; name: string; provider: string }[]> {
  const lists = await Promise.all(
    providers
      .filter(({ provider }) => provider.isConfigured())
      .map(({ provider }) => provider.listModels().catch(() => [] as ModelInfo[])),
  );
  return lists
    .flat()
    .filter((m) => isFreeModelId(m.id))
    .map((m) => ({ id: m.id, name: m.name, provider: m.provider }));
}

export async function findModel(id: string): Promise<ModelInfo | undefined> {
  try {
    const models = await providerFor(id).listModels();
    return models.find((m) => m.id === id);
  } catch {
    return undefined;
  }
}

/**
 * Order of models to try for a request: the requested model first, then the
 * configured fallbacks. Only free models are kept (Free Models Only policy);
 * when images are attached only vision models are kept.
 */
export function fallbackChain(
  requested: string,
  catalog: ModelInfo[],
  opts: { needsVision: boolean; paidAvailable: boolean | null },
): { chain: string[]; skipped: { id: string; reason: string }[] } {
  const cfg = modelConfig();
  const ids = [requested, ...cfg.fallbackModels.filter((m) => m !== requested)];
  const chain: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    if (!isFreeModelId(id)) {
      skipped.push({ id, reason: 'not a free model' });
      continue;
    }
    const info = catalog.find((m) => m.id === id);
    if (catalog.length && !info) {
      skipped.push({ id, reason: 'not currently offered by the provider' });
      continue;
    }
    if (info && opts.needsVision && !info.capabilities.vision) {
      skipped.push({ id, reason: 'cannot read images' });
      continue;
    }
    if (info && !info.free && opts.paidAvailable === false) {
      skipped.push({ id, reason: 'requires OpenRouter credits' });
      continue;
    }
    chain.push(id);
  }
  return { chain, skipped };
}
