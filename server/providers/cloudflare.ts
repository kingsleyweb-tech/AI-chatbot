/**
 * Cloudflare Workers AI chat provider (OpenAI-compatible endpoint).
 *
 * Model ids are Cloudflare's own ("@cf/<vendor>/<model>"), so the registry
 * routes the "@cf/" prefix here. These models are selectable in the picker
 * only: the router never picks them automatically and never falls back to
 * them (Gemini stays primary, OpenRouter secondary).
 *
 * Usage arrives as per-chunk deltas, including `usage.neurons`; they are
 * summed and reported so the app-wide Neuron cap can be enforced.
 */
import { chargeProviderRequest } from '../environments/index.js';
import { parseSSE } from '../shared/sse.js';
import type { ModelInfo } from '../shared/types.js';
import {
  aiBase,
  authHeader,
  cloudflareAccountIds,
  currentCloudflareAccount,
  cloudflareConfigured,
  cloudflareDailyLimitActive,
  cloudflareDailyLimitError,
  mapCloudflareError,
} from '../cloudflare/client.js';
import { ProviderError, type ChatProvider, type CompletionParams, type ProviderChunk } from './types.js';

export const CLOUDFLARE_PREFIX = '@cf/';
const CONNECT_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 90_000;

interface CfChatModel {
  id: string;
  label: string;
  blurb: string;
  vendor: string;
  vision?: boolean;
  reasoning?: boolean;
  code?: boolean;
  featured?: boolean;
}

/**
 * Curated, verified text models (none has a planned deprecation date). Each
 * one's context window and pricing come from Cloudflare's model list at run
 * time; a model missing from that list is not shown.
 */
export const CLOUDFLARE_CHAT_MODELS: CfChatModel[] = [
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B', vendor: 'google', blurb: 'Google Gemma 4 on Cloudflare: reasoning, images, 256K context. The lowest Neuron cost of the curated models.', vision: true, reasoning: true },
  { id: '@cf/openai/gpt-oss-120b', label: 'GPT-OSS 120B', vendor: 'openai', blurb: 'OpenAI open-weight reasoning model on Cloudflare, 128K context.', reasoning: true },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout', vendor: 'meta', blurb: 'Meta Llama 4 Scout on Cloudflare: text and images, 131K context.', vision: true },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1', vendor: 'mistralai', blurb: 'Mistral Small 3.1 on Cloudflare: text and images, 128K context.', vision: true },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B', vendor: 'qwen', blurb: 'Qwen coding model on Cloudflare, 32K context.', code: true },
];

interface CfModelListing {
  name: string;
  properties?: { property_id: string; value: unknown }[];
}

let modelCache: { at: number; models: ModelInfo[] } | null = null;
const MODEL_TTL = 30 * 60_000;

/** USD per million tokens from a listing's price property. */
function priceOf(listing: CfModelListing | undefined): { prompt: number; completion: number } | undefined {
  const prop = listing?.properties?.find((p) => p.property_id === 'price')?.value;
  if (!Array.isArray(prop)) return undefined;
  const find = (re: RegExp) => Number((prop as { unit?: string; price?: number }[]).find((p) => re.test(p.unit ?? ''))?.price ?? NaN);
  const prompt = find(/input/i);
  const completion = find(/output/i);
  return Number.isFinite(prompt) && Number.isFinite(completion) ? { prompt, completion } : undefined;
}

export function mapCloudflareModel(cfg: CfChatModel, listing: CfModelListing | undefined): ModelInfo | null {
  if (!listing) return null;
  const props = Object.fromEntries((listing.properties ?? []).map((p) => [p.property_id, p.value]));
  if (props.planned_deprecation_date) return null;
  const vision = cfg.vision ?? String(props.vision) === 'true';
  return {
    id: cfg.id,
    name: `Cloudflare: ${cfg.label}`,
    provider: 'cloudflare',
    vendor: cfg.vendor,
    description: cfg.blurb,
    contextLength: Number(props.context_window ?? 0) || 0,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'],
    // Covered by the free daily Neuron allowance; the app stops at its own cap
    // below that allowance and never moves to paid usage.
    free: true,
    pricing: priceOf(listing),
    capabilities: {
      vision,
      audioInput: false,
      fileInput: false,
      imageOutput: false,
      audioOutput: false,
      tools: String(props.function_calling) === 'true',
      reasoning: Boolean(cfg.reasoning),
      structuredOutput: false,
      streaming: true,
      code: Boolean(cfg.code),
    },
    available: true,
    // not in the Featured list: Gemini and OpenRouter stay the main choices
    featured: Boolean(cfg.featured),
  };
}

export class CloudflareProvider implements ChatProvider {
  readonly id = 'cloudflare';

  isConfigured(): boolean {
    return cloudflareConfigured();
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.isConfigured()) return [];
    if (modelCache && Date.now() - modelCache.at < MODEL_TTL) return modelCache.models;
    // the catalogue is the same on every account: the first one that answers is enough
    let result: CfModelListing[] | undefined;
    let lastErr: unknown = null;
    for (const account of cloudflareAccountIds()) {
      try {
        const res = await fetch(`${aiBase(account)}/models/search?per_page=100&task=Text%20Generation`, {
          headers: authHeader(account),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw mapCloudflareError(res.status, await res.text(), account);
        result = ((await res.json()) as { result?: CfModelListing[] }).result;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    const models = CLOUDFLARE_CHAT_MODELS.map((cfg) => mapCloudflareModel(cfg, result?.find((r) => r.name === cfg.id))).filter(
      (m): m is ModelInfo => m !== null,
    );
    if (cloudflareDailyLimitActive()) models.forEach((m) => (m.available = false));
    modelCache = { at: Date.now(), models };
    return models;
  }

  private body(p: CompletionParams, stream: boolean) {
    return JSON.stringify({
      model: p.model,
      messages: p.messages,
      stream,
      max_tokens: p.maxTokens ?? 4096,
      temperature: p.temperature,
      ...(p.json ? { response_format: { type: 'json_object' } } : {}),
    });
  }

  async *stream(p: CompletionParams): AsyncGenerator<ProviderChunk> {
    // the account the engine's Neuron reservation was made on (else the first configured one)
    const account = p.account ?? currentCloudflareAccount();
    const headers = { ...authHeader(account), 'content-type': 'application/json' }; // throws not_configured first
    if (cloudflareDailyLimitActive(Date.now(), account)) throw cloudflareDailyLimitError();
    await chargeProviderRequest('cloudflare');
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), p.firstByteTimeoutMs ?? CONNECT_TIMEOUT_MS);
    const signal = AbortSignal.any([connect.signal, p.signal].filter(Boolean) as AbortSignal[]);
    let res: Response;
    try {
      res = await fetch(`${aiBase(account)}/v1/chat/completions`, { method: 'POST', headers, body: this.body(p, true), signal });
    } catch (err) {
      clearTimeout(timer);
      if (p.signal?.aborted) throw err;
      if (connect.signal.aborted) throw new ProviderError('timeout', 'The model took too long to start responding.', 504);
      throw new ProviderError('provider_error', 'Could not reach Cloudflare Workers AI.', 502);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw mapCloudflareError(res.status, await res.text(), account, res.headers.get('retry-after'));
    }
    clearTimeout(timer);
    yield* readStream(res, p, connect, signal);
  }

  async complete(p: CompletionParams): Promise<string> {
    const account = p.account ?? currentCloudflareAccount();
    if (cloudflareDailyLimitActive(Date.now(), account)) throw cloudflareDailyLimitError();
    const headers = { ...authHeader(account), 'content-type': 'application/json' };
    await chargeProviderRequest('cloudflare');
    let res: Response;
    try {
      res = await fetch(`${aiBase(account)}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: this.body(p, false),
        signal: AbortSignal.any([AbortSignal.timeout(CONNECT_TIMEOUT_MS), p.signal].filter(Boolean) as AbortSignal[]),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('timeout', 'The model did not respond in time.', 504);
    }
    if (!res.ok) throw mapCloudflareError(res.status, await res.text(), account, res.headers.get('retry-after'));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

type CfChunk = {
  model?: string;
  errors?: { code?: number; message?: string }[];
  error?: { message?: string; code?: number } | string;
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; neurons?: number };
};

/** Parse the OpenAI-compatible SSE stream; usage values are per-chunk deltas and are summed. */
export async function* readStream(res: Response, p: CompletionParams, connect: AbortController, signal: AbortSignal): AsyncGenerator<ProviderChunk> {
  let model = p.model;
  let finish: string | null = null;
  let gotContent = false;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, neurons: 0 };
  let sawUsage = false;
  let idle = setTimeout(() => connect.abort(), p.firstByteTimeoutMs ?? CONNECT_TIMEOUT_MS);
  try {
    for await (const data of parseSSE(res.body!, signal)) {
      clearTimeout(idle);
      idle = setTimeout(() => connect.abort(), IDLE_TIMEOUT_MS);
      if (data === '[DONE]') break;
      let chunk: CfChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.errors?.length || chunk.error) throw mapCloudflareError(502, JSON.stringify(chunk));
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.reasoning_content) yield { type: 'reasoning', text: choice.delta.reasoning_content };
      if (choice?.delta?.content) {
        gotContent = true;
        yield { type: 'delta', text: choice.delta.content };
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        sawUsage = true;
        usage.promptTokens += chunk.usage.prompt_tokens ?? 0;
        usage.completionTokens += chunk.usage.completion_tokens ?? 0;
        usage.totalTokens += chunk.usage.total_tokens ?? 0;
        usage.neurons += Number(chunk.usage.neurons ?? 0) || 0;
      }
    }
  } catch (err) {
    if (p.signal?.aborted) throw err;
    if (connect.signal.aborted) throw new ProviderError('timeout', gotContent ? 'The response stalled.' : 'The model took too long to respond.', 504);
    throw err;
  } finally {
    clearTimeout(idle);
  }
  if (sawUsage) yield { type: 'usage', usage: { ...usage, neurons: +usage.neurons.toFixed(3) } };
  if (finish === 'error') throw new ProviderError('provider_error', 'The model stopped with an error.', 502);
  yield { type: 'finish', reason: finish, model };
}
