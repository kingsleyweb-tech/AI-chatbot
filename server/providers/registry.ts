import type { ModelCatalog, ModelInfo } from '../shared/types.js';
import { modelConfig } from '../config/models.js';
import { OpenRouterProvider } from './openrouter.js';
import type { ChatProvider } from './types.js';

/**
 * Provider registry. To add Gemini/OpenAI/Anthropic later, implement
 * ChatProvider and register it here with a model-id prefix, e.g. "gemini:".
 */
const openrouter = new OpenRouterProvider();
const providers: { prefix: string; provider: ChatProvider }[] = [
  // { prefix: 'gemini:', provider: new GeminiProvider() },
  { prefix: '', provider: openrouter },
];

export function providerFor(modelId: string): ChatProvider {
  return providers.find((p) => modelId.startsWith(p.prefix))!.provider;
}

export function embeddingProvider(): ChatProvider {
  return openrouter;
}

export function configuredProviders(): string[] {
  return providers.filter((p) => p.provider.isConfigured()).map((p) => p.provider.id);
}

export async function getCatalog(): Promise<ModelCatalog> {
  const cfg = modelConfig();
  const all: ModelInfo[] = [];
  for (const { provider } of providers) {
    if (!provider.isConfigured()) continue;
    all.push(...(await provider.listModels()));
  }
  const paidAvailable = await openrouter.paidAvailable();
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
