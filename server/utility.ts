import { modelConfig } from './config/models.js';
import { providerFor } from './providers/registry.js';
import type { ProviderMessage } from './providers/types.js';

/**
 * Run a short background completion on the first utility model that works.
 * Used for titles, summaries and memory extraction.
 */
export async function utilityComplete(
  messages: ProviderMessage[],
  opts: { json?: boolean; maxTokens?: number } = {},
): Promise<string | null> {
  for (const model of modelConfig().utilityModels) {
    try {
      const out = await providerFor(model).complete({
        model,
        messages,
        maxTokens: opts.maxTokens ?? 800,
        temperature: 0.2,
        json: opts.json,
      });
      if (out.trim()) return out.trim();
    } catch (err) {
      console.warn(`[utility] ${model} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return null;
}

/** Extract the first JSON object from model output (tolerates code fences / prose). */
export function parseJsonObject<T>(text: string | null): T | null {
  if (!text) return null;
  const stripped = text.replace(/^```(?:json)?/im, '').replace(/```\s*$/m, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Strip reasoning tags some models put inline in content. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
