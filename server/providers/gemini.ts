/**
 * Google Gemini Developer API (AI Studio) provider.
 *
 * Model ids are namespaced as "gemini:<model>" so they can live next to
 * OpenRouter ids in one catalog and one router. The key is server-only
 * (GEMINI_API_KEY, plus GEMINI_API_KEY_SECONDARY for a second project: see geminiAccounts.ts);
 * it is sent in a header, never in a URL or to the client.
 *
 * Cost (Free Models Only policy, server/billing/policy.ts): only models that
 * Google lists as "Free of charge" on the Free Tier are marked free and used.
 * The Google project must keep billing disabled. If GEMINI_BILLING=paid is set,
 * no Gemini model is used at all.
 */
import { geminiBillingPaid, GEMINI_FREE_TIER } from '../billing/policy.js';
import { parseSSE } from '../shared/sse.js';
import { exhaustedError, geminiAccounts, leases, newAttemptState, setAccountModels, withGeminiAccount } from './geminiAccounts.js';
import type { ModelInfo } from '../shared/types.js';
import {
  ProviderError,
  type ChatProvider,
  type CompletionParams,
  type ContentPart,
  type ProviderChunk,
  type ProviderMessage,
} from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_PREFIX = 'gemini:';
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 90_000;

/**
 * Curated chat models (verified against the models list for this key;
 * Gemini 2.5 models are no longer offered to new keys).
 * Only models that exist for the key right now are shown.
 */
export const GEMINI_CHAT_MODELS: { id: string; blurb: string; featured?: boolean; audio?: boolean }[] = [
  { id: 'gemini-3.8-flash', blurb: 'Google’s newest Flash model: text, images, audio, 1M context. Often busy on the free tier.', audio: true },
  { id: 'gemini-3.6-flash', blurb: 'Fast multimodal Gemini model: text, images, audio, 1M-token context.', featured: true, audio: true },
  // Not on the Free Tier: listed so it can be recognised, but never offered or used.
  { id: 'gemini-3.5-flash', blurb: 'Fast multimodal Gemini model. Not in the free tier.', audio: true },
  { id: 'gemini-3.5-flash-lite', blurb: 'Lightweight, quick Gemini model for everyday tasks.', audio: true },
  { id: 'gemini-3.1-flash-lite', blurb: 'Lightweight Gemini model.', audio: true },
  { id: 'gemini-3.1-pro-preview', blurb: 'Most capable Gemini reasoning model (preview). Not in the free tier.', audio: true },
];

interface GModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

let modelCache: { at: number; models: ModelInfo[] } | null = null;
const MODEL_TTL = 30 * 60_000;

export const toGeminiId = (model: string) => model.replace(GEMINI_PREFIX, '');

/** Free of charge on Google's Free Tier (and Atlas AI is not set to a billed project). */
function geminiFree(raw: string): boolean {
  return !geminiBillingPaid() && GEMINI_FREE_TIER.has(raw);
}

export function mapGeminiModel(m: GModel): ModelInfo | null {
  const raw = m.name.replace(/^models\//, '');
  const cfg = GEMINI_CHAT_MODELS.find((c) => c.id === raw);
  if (!cfg || !m.supportedGenerationMethods?.includes('generateContent')) return null;
  const free = geminiFree(raw);
  const inputs: ModelInfo['inputModalities'] = cfg.audio ? ['text', 'image', 'audio', 'file'] : ['text', 'image'];
  return {
    id: GEMINI_PREFIX + raw,
    name: `Google: ${m.displayName ?? raw}${free ? ' (free tier)' : ''}`,
    provider: 'gemini',
    vendor: 'google',
    description: cfg.blurb,
    contextLength: m.inputTokenLimit ?? 0,
    inputModalities: inputs,
    outputModalities: ['text'],
    free,
    capabilities: {
      vision: true,
      audioInput: Boolean(cfg.audio),
      fileInput: Boolean(cfg.audio),
      imageOutput: false,
      audioOutput: false,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      streaming: true,
      // Flash and Pro are general coding models; Lite variants are not listed for code
      code: !raw.includes('lite'),
    },
    available: true,
    featured: Boolean(cfg.featured),
  };
}

/** Map a Gemini API error to a typed ProviderError. */
export function mapGeminiError(status: number, body: string): ProviderError {
  let message = body;
  let details: { '@type'?: string; violations?: { quotaId?: string; quotaValue?: string | number }[]; retryDelay?: string }[] = [];
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } } | { error?: unknown }[];
    const e = Array.isArray(parsed) ? (parsed[0] as { error?: { message?: string } })?.error : parsed.error;
    message = (e as { message?: string })?.message ?? body;
    details = ((e as { details?: typeof details })?.details ?? []).filter((d) => d && typeof d === 'object');
  } catch {
    /* keep raw */
  }
  const lower = message.toLowerCase();
  if (status === 400 && lower.includes('api key')) return new ProviderError('invalid_key', 'Google rejected the Gemini API key.', 401);
  if (status === 401 || status === 403) return new ProviderError('invalid_key', 'Google rejected the Gemini API key.', 401);
  if (status === 429 && /limit:\s*0\b/.test(lower))
    return new ProviderError('model_unavailable', 'This Gemini model is not included in the free tier.', 404);
  if (status === 429) {
    // Google names the exhausted quota (QuotaFailure) and how long to wait (RetryInfo).
    const violation = details.flatMap((d) => d.violations ?? []).find((v) => v.quotaId);
    const delay = details.map((d) => d.retryDelay).find((d): d is string => typeof d === 'string');
    const seconds = delay ? Number.parseFloat(delay) : NaN;
    const perDay = /PerDay/i.test(violation?.quotaId ?? '');
    const e = perDay
      ? new ProviderError('daily_limit', 'The Gemini free-tier daily quota for this model is used up. It resets at midnight Pacific time.', 429)
      : new ProviderError('rate_limited', 'The Gemini free-tier quota for this model is used up for now.', 429);
    if (Number.isFinite(seconds) && seconds > 0) e.retryAfterMs = Math.ceil(seconds * 1000);
    if (violation?.quotaId) {
      const value = Number(violation.quotaValue);
      e.quota = { id: String(violation.quotaId).slice(0, 120), value: Number.isFinite(value) ? value : null, perDay };
    }
    return e;
  }
  if (status === 404) return new ProviderError('model_unavailable', 'This Gemini model is currently unavailable.', 404);
  if (lower.includes('token') && (lower.includes('exceed') || lower.includes('too long') || lower.includes('limit')))
    return new ProviderError('context_too_long', 'The conversation is too long for this model.', 400);
  if (lower.includes('safety') || lower.includes('blocked')) return new ProviderError('moderation', 'Gemini blocked this request.', 403);
  if (status >= 500) return new ProviderError('provider_error', 'Gemini had a temporary problem.', 502);
  return new ProviderError('bad_request', `Gemini rejected the request: ${message.slice(0, 200)}`, 400);
}

type GPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function toParts(content: string | ContentPart[]): GPart[] {
  if (typeof content === 'string') return [{ text: content || ' ' }];
  const parts: GPart[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push({ text: p.text || ' ' });
    else {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url.url);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
  }
  return parts.length ? parts : [{ text: ' ' }];
}

/** OpenAI-style messages -> Gemini contents (system goes to systemInstruction; roles must alternate). */
export function toGeminiRequest(messages: ProviderMessage[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')))
    .join('\n\n');
  const contents: { role: 'user' | 'model'; parts: GPart[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = toParts(m.content);
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents };
}

interface GChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  error?: { code?: number; message?: string };
}

export class GeminiProvider implements ChatProvider {
  readonly id = 'gemini';

  isConfigured(): boolean {
    return geminiAccounts().length > 0;
  }

  private headers(key: string): HeadersInit {
    if (!key) throw new ProviderError('not_configured', 'GEMINI_API_KEY is not configured.', 500);
    return { 'x-goog-api-key': key, 'content-type': 'application/json' };
  }

  /** Models offered by any configured account (each account's own list is remembered for routing). */
  async listModels(): Promise<ModelInfo[]> {
    if (modelCache && Date.now() - modelCache.at < MODEL_TTL) return modelCache.models;
    const accounts = geminiAccounts();
    if (!accounts.length) throw new ProviderError('not_configured', 'GEMINI_API_KEY is not configured.', 500);
    const results = await Promise.allSettled(
      accounts.map(async (a) => {
        const res = await fetch(`${BASE}/models?pageSize=200`, { headers: this.headers(a.key), signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw mapGeminiError(res.status, await res.text());
        const { models = [] } = (await res.json()) as { models?: GModel[] };
        setAccountModels(a.id, models.map((m) => m.name.replace(/^models\//, '')));
        return models;
      }),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<GModel[]> => r.status === 'fulfilled');
    if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
    const seen = new Map<string, ModelInfo>();
    for (const r of ok) for (const m of r.value.map(mapGeminiModel)) if (m && !seen.has(m.id)) seen.set(m.id, m);
    const mapped = [...seen.values()];
    // keep the curated order
    mapped.sort(
      (a, b) =>
        GEMINI_CHAT_MODELS.findIndex((c) => GEMINI_PREFIX + c.id === a.id) -
        GEMINI_CHAT_MODELS.findIndex((c) => GEMINI_PREFIX + c.id === b.id),
    );
    modelCache = { at: Date.now(), models: mapped };
    return mapped;
  }

  private body(p: CompletionParams) {
    const id = toGeminiId(p.model);
    return JSON.stringify({
      ...toGeminiRequest(p.messages),
      generationConfig: {
        maxOutputTokens: p.maxTokens ?? 8192,
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.json ? { responseMimeType: 'application/json' } : {}),
        ...(id.startsWith('gemini-')
          ? {
              // Short background calls (titles, memory, plans) skip thinking so it can't
              // consume the whole output budget; chat replies stream their thoughts.
              thinkingConfig:
                (p.maxTokens ?? 8192) > 2048 || id.includes('pro')
                  ? { includeThoughts: true }
                  : id.includes('lite')
                    ? { thinkingLevel: 'minimal' } // lite models reject a zero budget
                    : { thinkingBudget: 0 },
            }
          : {}),
      },
    });
  }

  /**
   * Stream from the best available account. A limit or outage before the first text moves the
   * request to the other account; once text has been sent, the error goes to the caller (one
   * request never produces two answers).
   */
  async *stream(p: CompletionParams): AsyncGenerator<ProviderChunk> {
    const model = toGeminiId(p.model);
    const state = newAttemptState();
    for await (const lease of leases(model, state)) {
      let started = false;
      try {
        for await (const chunk of this.streamOn(p, lease.account.key)) {
          if (chunk.type === 'delta' || chunk.type === 'reasoning') started = true;
          yield chunk;
        }
        lease.ok();
        return;
      } catch (err) {
        const next = lease.fail(err);
        if (started || next === 'stop') throw err;
        state.errors.push(err);
      } finally {
        lease.end();
      }
    }
    throw exhaustedError(model, state);
  }

  private async *streamOn(p: CompletionParams, key: string): AsyncGenerator<ProviderChunk> {
    const headers = this.headers(key);
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), p.firstByteTimeoutMs ?? CONNECT_TIMEOUT_MS);
    const signal = AbortSignal.any([connect.signal, p.signal].filter(Boolean) as AbortSignal[]);
    let res: Response;
    try {
      res = await fetch(`${BASE}/models/${encodeURIComponent(toGeminiId(p.model))}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers,
        body: this.body(p),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (p.signal?.aborted) throw err;
      if (connect.signal.aborted) throw new ProviderError('timeout', 'Gemini took too long to start responding.', 504);
      throw new ProviderError('provider_error', 'Could not reach Gemini.', 502);
    }
    clearTimeout(timer);
    if (!res.ok || !res.body) throw mapGeminiError(res.status, await res.text());

    let finish: string | null = null;
    let usage: GChunk['usageMetadata'] | undefined;
    let idle = setTimeout(() => connect.abort(), IDLE_TIMEOUT_MS);
    try {
      for await (const data of parseSSE(res.body, signal)) {
        clearTimeout(idle);
        idle = setTimeout(() => connect.abort(), IDLE_TIMEOUT_MS);
        let chunk: GChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw mapGeminiError(chunk.error.code ?? 502, JSON.stringify(chunk));
        if (chunk.promptFeedback?.blockReason) throw new ProviderError('moderation', 'Gemini blocked this request.', 403);
        const cand = chunk.candidates?.[0];
        for (const part of cand?.content?.parts ?? []) {
          if (!part.text) continue;
          yield part.thought ? { type: 'reasoning', text: part.text } : { type: 'delta', text: part.text };
        }
        if (cand?.finishReason) finish = cand.finishReason === 'MAX_TOKENS' ? 'length' : cand.finishReason.toLowerCase();
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
      }
    } catch (err) {
      if (p.signal?.aborted) throw err;
      if (err instanceof ProviderError) throw err;
      if (connect.signal.aborted) throw new ProviderError('timeout', 'Gemini stopped responding.', 504);
      throw new ProviderError('provider_error', 'The Gemini stream was interrupted.', 502);
    } finally {
      clearTimeout(idle);
    }
    if (usage) {
      const completion = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
      yield {
        type: 'usage',
        usage: {
          promptTokens: usage.promptTokenCount ?? 0,
          completionTokens: completion,
          totalTokens: usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + completion,
          // free tier: nothing is billed
          ...(geminiFree(toGeminiId(p.model)) ? { cost: 0 } : {}),
        },
      };
    }
    yield { type: 'finish', reason: finish, model: p.model };
  }

  async complete(p: CompletionParams): Promise<string> {
    return withGeminiAccount(toGeminiId(p.model), (a) => this.completeOn(p, a.key));
  }

  private async completeOn(p: CompletionParams, key: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/models/${encodeURIComponent(toGeminiId(p.model))}:generateContent`, {
        method: 'POST',
        headers: this.headers(key),
        body: this.body(p),
        signal: AbortSignal.any([AbortSignal.timeout(CONNECT_TIMEOUT_MS), p.signal].filter(Boolean) as AbortSignal[]),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (p.signal?.aborted) throw err;
      throw new ProviderError('timeout', 'Gemini did not respond in time.', 504);
    }
    if (!res.ok) throw mapGeminiError(res.status, await res.text());
    const data = (await res.json()) as GChunk;
    return (data.candidates?.[0]?.content?.parts ?? [])
      .filter((x) => !x.thought && x.text)
      .map((x) => x.text)
      .join('');
  }

  /** Embeddings (768 dims) via gemini-embedding models; both accounts give the same vectors. */
  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const id = toGeminiId(model);
    return withGeminiAccount(id, async (a) => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/models/${encodeURIComponent(id)}:batchEmbedContents`, {
          method: 'POST',
          headers: this.headers(a.key),
          body: JSON.stringify({
            requests: inputs.map((text) => ({ model: `models/${id}`, content: { parts: [{ text }] }, outputDimensionality: 768 })),
          }),
          signal: signal ?? AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new ProviderError('timeout', 'Gemini did not respond in time.', 504);
      }
      if (!res.ok) throw mapGeminiError(res.status, await res.text());
      const data = (await res.json()) as { embeddings?: { values: number[] }[] };
      if (!data.embeddings?.length) throw new ProviderError('provider_error', 'No embeddings returned.');
      return data.embeddings.map((e) => e.values);
    });
  }
}
