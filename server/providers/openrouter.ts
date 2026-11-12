import { env } from '../env.js';
import { FEATURED_MODELS, TASK_PREFERENCES } from '../config/models.js';
import { parseSSE } from '../shared/sse.js';
import type { Modality, ModelInfo } from '../shared/types.js';
import {
  ProviderError,
  type ChatProvider,
  type CompletionParams,
  type ProviderChunk,
} from './types.js';

const BASE = 'https://openrouter.ai/api/v1';
const CONNECT_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 90_000;

interface ORModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

let modelCache: { at: number; models: ModelInfo[] } | null = null;
let keyCache: { at: number; paid: boolean | null } | null = null;
const MODEL_TTL = 10 * 60_000;

export function mapModel(m: ORModel, featuredIds: string[]): ModelInfo {
  const params = m.supported_parameters ?? [];
  const inputs = (m.architecture?.input_modalities ?? ['text']).filter((x): x is Modality =>
    ['text', 'image', 'file', 'audio', 'video'].includes(x),
  );
  const outputs = (m.architecture?.output_modalities ?? ['text']).filter((x): x is Modality =>
    ['text', 'image', 'file', 'audio', 'video'].includes(x),
  );
  const prompt = Number(m.pricing?.prompt ?? NaN);
  const completion = Number(m.pricing?.completion ?? NaN);
  const free = m.id.endsWith(':free') || (prompt === 0 && completion === 0);
  const featured = FEATURED_MODELS.find((f) => f.id === m.id);
  const [vendor] = m.id.split('/');
  return {
    id: m.id,
    name: featured?.label ?? m.name.replace(/\s*\(free\)\s*$/i, '') + (m.id.endsWith(':free') ? ' (free)' : ''),
    provider: 'openrouter',
    vendor,
    description: featured?.blurb ?? (m.description ?? '').slice(0, 280),
    contextLength: m.context_length ?? 0,
    inputModalities: inputs.length ? inputs : ['text'],
    outputModalities: outputs.length ? outputs : ['text'],
    free,
    pricing: Number.isFinite(prompt)
      ? { prompt: +(prompt * 1e6).toFixed(4), completion: +(completion * 1e6).toFixed(4) }
      : undefined,
    capabilities: {
      vision: inputs.includes('image'),
      audioInput: inputs.includes('audio'),
      fileInput: inputs.includes('file'),
      imageOutput: outputs.includes('image'),
      audioOutput: outputs.includes('audio'),
      tools: params.includes('tools'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      structuredOutput: params.includes('response_format') || params.includes('structured_outputs'),
      streaming: true,
      code: TASK_PREFERENCES.code.includes(m.id),
    },
    available: true,
    featured: featuredIds.includes(m.id),
  };
}

/** Free-model daily cap: remembered in-process until the next UTC midnight. */
let freeDailyLimitUntil = 0;
function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
export function markFreeDailyLimit(now = Date.now()) {
  freeDailyLimitUntil = nextUtcMidnight(now);
}
export function freeDailyLimitActive(now = Date.now()): boolean {
  return now < freeDailyLimitUntil;
}
export function resetFreeDailyLimit() {
  freeDailyLimitUntil = 0;
}
function dailyLimitError(): ProviderError {
  return new ProviderError(
    'daily_limit',
    'The daily limit for free OpenRouter models has been reached (50 requests per day on an account without purchased credits). It resets at midnight UTC.',
    429,
  );
}

/** Map an OpenRouter HTTP error to a typed ProviderError. */
export function mapError(status: number, body: string): ProviderError {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; metadata?: { raw?: string } } };
    message = parsed.error?.message ?? body;
  } catch {
    /* keep raw */
  }
  const lower = message.toLowerCase();
  if (status === 401) return new ProviderError('invalid_key', 'The AI provider rejected the API key.', 401);
  if (status === 402)
    return new ProviderError('insufficient_credits', 'This model needs OpenRouter credits, and the account has none.', 402);
  if (status === 429 && /per[- ]day|daily/.test(lower)) {
    // Account-wide cap on free-model requests: every free model fails the same way
    // until it resets, so trying other free models would only waste requests.
    markFreeDailyLimit();
    return dailyLimitError();
  }
  if (status === 429) return new ProviderError('rate_limited', 'The model is rate-limited right now.', 429);
  if (status === 408) return new ProviderError('timeout', 'The model took too long to respond.', 504);
  if (status === 403 && lower.includes('moderation'))
    return new ProviderError('moderation', 'The request was blocked by the provider’s moderation.', 403);
  if (lower.includes('image') && (lower.includes('support') || lower.includes('endpoint')))
    return new ProviderError('unsupported_input', 'This model cannot read images.', 400);
  if (lower.includes('context') && (lower.includes('length') || lower.includes('too long') || lower.includes('maximum')))
    return new ProviderError('context_too_long', 'The conversation is too long for this model.', 400);
  if (status === 404) return new ProviderError('model_unavailable', 'This model is currently unavailable.', 404);
  if (status >= 500) return new ProviderError('provider_error', 'The AI provider had a temporary problem.', 502);
  return new ProviderError('bad_request', `The AI provider rejected the request: ${message.slice(0, 200)}`, 400);
}

export class OpenRouterProvider implements ChatProvider {
  readonly id = 'openrouter';

  isConfigured(): boolean {
    return Boolean(env().openRouterKey);
  }

  private headers(): HeadersInit {
    const key = env().openRouterKey;
    if (!key) throw new ProviderError('not_configured', 'OPENROUTER_API_KEY is not configured.', 500);
    return {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'http-referer': env().appUrl,
      'x-title': 'Atlas AI',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (modelCache && Date.now() - modelCache.at < MODEL_TTL) return modelCache.models;
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw mapError(res.status, await res.text());
    const { data } = (await res.json()) as { data: ORModel[] };
    const featuredIds = FEATURED_MODELS.map((f) => f.id);
    const models = data
      .filter((m) => (m.architecture?.output_modalities ?? ['text']).includes('text'))
      .map((m) => mapModel(m, featuredIds));
    modelCache = { at: Date.now(), models };
    return models;
  }

  /** Whether the key's account has purchased credits (can use paid models). */
  async paidAvailable(): Promise<boolean | null> {
    if (keyCache && Date.now() - keyCache.at < MODEL_TTL) return keyCache.paid;
    try {
      const res = await fetch(`${BASE}/key`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const { data } = (await res.json()) as {
        data: {
          is_free_tier?: boolean;
          limit_remaining?: number | null;
          free_model_daily_requests?: { remaining?: number };
        };
      };
      // Learn about an exhausted free daily quota without spending a failed request on it.
      if (data.free_model_daily_requests?.remaining === 0) markFreeDailyLimit();
      const paid = data.is_free_tier === false && (data.limit_remaining == null || data.limit_remaining > 0);
      keyCache = { at: Date.now(), paid };
      return paid;
    } catch {
      return null;
    }
  }

  /**
   * The key's account status as OpenRouter reports it (GET /key: free to call, uses no requests),
   * for the administrator provider view. Never contains the key itself.
   */
  async accountStatus(): Promise<{ freeTier: boolean | null; freeDailyRemaining: number | null; creditsRemaining: number | null } | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await fetch(`${BASE}/key`, { headers: this.headers(), signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const { data } = (await res.json()) as {
        data: { is_free_tier?: boolean; limit_remaining?: number | null; free_model_daily_requests?: { remaining?: number } };
      };
      const free = data.free_model_daily_requests?.remaining;
      if (free === 0) markFreeDailyLimit();
      return {
        freeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
        freeDailyRemaining: typeof free === 'number' ? free : null,
        creditsRemaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null,
      };
    } catch {
      return null;
    }
  }

  private body(p: CompletionParams, stream: boolean) {
    return JSON.stringify({
      model: p.model,
      messages: p.messages,
      stream,
      max_tokens: p.maxTokens,
      temperature: p.temperature,
      ...(p.json ? { response_format: { type: 'json_object' } } : {}),
      ...(stream ? { usage: { include: true } } : {}),
    });
  }

  async *stream(p: CompletionParams): AsyncGenerator<ProviderChunk> {
    const headers = this.headers(); // throws not_configured before any network call
    if (p.model.endsWith(':free') && freeDailyLimitActive()) throw dailyLimitError();
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), p.firstByteTimeoutMs ?? CONNECT_TIMEOUT_MS);
    const signals = [connect.signal, p.signal].filter(Boolean) as AbortSignal[];
    const signal = AbortSignal.any(signals);
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers,
        body: this.body(p, true),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (p.signal?.aborted) throw err;
      if (connect.signal.aborted) throw new ProviderError('timeout', 'The model took too long to start responding.', 504);
      throw new ProviderError('provider_error', 'Could not reach the AI provider.', 502);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw mapError(res.status, await res.text());
    }

    let model = p.model;
    let finish: string | null = null;
    let gotContent = false;
    // idle watchdog: abort if the stream stalls
    let idle = setTimeout(() => connect.abort(), p.firstByteTimeoutMs ?? CONNECT_TIMEOUT_MS);
    clearTimeout(timer);
    try {
      for await (const data of parseSSE(res.body, signal)) {
        clearTimeout(idle);
        idle = setTimeout(() => connect.abort(), IDLE_TIMEOUT_MS);
        if (data === '[DONE]') break;
        let chunk: {
          model?: string;
          error?: { code?: number | string; message?: string };
          choices?: { delta?: { content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          const status = typeof chunk.error.code === 'number' ? chunk.error.code : 502;
          throw mapError(status, JSON.stringify({ error: chunk.error }));
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.reasoning) yield { type: 'reasoning', text: choice.delta.reasoning };
        if (choice?.delta?.content) {
          gotContent = true;
          yield { type: 'delta', text: choice.delta.content };
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              cost: chunk.usage.cost,
            },
          };
        }
      }
    } catch (err) {
      if (p.signal?.aborted) throw err;
      if (connect.signal.aborted) {
        throw new ProviderError('timeout', gotContent ? 'The response stalled.' : 'The model took too long to respond.', 504);
      }
      throw err;
    } finally {
      clearTimeout(idle);
    }
    if (finish === 'error') throw new ProviderError('provider_error', 'The model stopped with an error.', 502);
    yield { type: 'finish', reason: finish, model };
  }

  async complete(p: CompletionParams): Promise<string> {
    if (p.model.endsWith(':free') && freeDailyLimitActive()) throw dailyLimitError();
    const signals = [AbortSignal.timeout(CONNECT_TIMEOUT_MS), p.signal].filter(Boolean) as AbortSignal[];
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: this.body(p, false),
        signal: AbortSignal.any(signals),
      });
    } catch {
      throw new ProviderError('timeout', 'The model did not respond in time.', 504);
    }
    if (!res.ok) throw mapError(res.status, await res.text());
    const data = (await res.json()) as {
      error?: { code?: number; message?: string };
      choices?: { message?: { content?: string } }[];
    };
    if (data.error) throw mapError(data.error.code ?? 502, JSON.stringify(data));
    return data.choices?.[0]?.message?.content ?? '';
  }

  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${BASE}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input: inputs }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw mapError(res.status, await res.text());
    const data = (await res.json()) as { data?: { embedding: number[]; index: number }[]; error?: { message?: string } };
    if (!data.data?.length) throw new ProviderError('provider_error', data.error?.message ?? 'No embeddings returned.');
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
