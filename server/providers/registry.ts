import type { ModelCatalog, ModelInfo } from '../shared/types.js';
import { modelConfig } from '../config/models.js';
import { GEMINI_PREFIX, GeminiProvider } from './gemini.js';
import { freeDailyLimitActive, OpenRouterProvider } from './openrouter.js';
import type { ChatProvider } from './types.js';

/**
 * Provider registry. Each provider owns a model-id prefix ("gemini:"); the
 * empty prefix (OpenRouter) catches everything else. One catalog, one router,
 * one conversation engine for all of them.
 */
const openrouter = new OpenRouterProvider();
const gemini = new GeminiProvider();
const providers: { prefix: string; provider: ChatProvider }[] = [
  { prefix: GEMINI_PREFIX, provider: gemini },
  { prefix: '', provider: openrouter },
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
  // checked first: the key info also tells us when the free daily quota is used up
  const paidAvailable = openrouter.isConfigured() ? await openrouter.paidAvailable() : null;
  const limited = freeDailyLimitActive();
  for (const list of lists) {
    // Free OpenRouter models are all blocked once the account-wide daily cap is hit.
    all.push(...(limited ? list.map((m) => (m.provider === 'openrouter' && m.free ? { ...m, available: false } : m)) : list));
  }
  if (!all.length && !lists.length) throw new Error('No AI provider is configured.');
  return {
    models: all,
    defaultModel: cfg.defaultModel,
    fallbackModels: cfg.fallbackModels,
    paidAvailable,
    fetchedAt: new Date().toISOString(),
  };
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
 * configured fallbacks. Paid models are skipped when the account has no
 * credits; when images are attached only vision models are kept.
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
