/**
 * ElevenLabs API access (server-only). The official SDK reads ELEVENLABS_API_KEY from the server
 * environment; the key never reaches the browser, Firestore, logs, error messages or responses.
 *
 * Errors are mapped to ProviderError with Atlas AI's own wording: the provider's message is never
 * passed on (it can echo request details), only a status and a short code.
 */
import { ElevenLabsClient, ElevenLabsError, ElevenLabsTimeoutError } from '@elevenlabs/elevenlabs-js';
import { ELEVEN_API } from '../config/elevenlabs.js';
import { ProviderError } from '../providers/types.js';

let fetchOverride: typeof fetch | null = null;
let client: ElevenLabsClient | null = null;

/** Tests and local scripted runs: route every SDK request through this fetch (no network). */
export function setElevenLabsFetch(f: typeof fetch | null) {
  fetchOverride = f;
  client = null;
}

export function elevenLabsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim()) || fetchOverride !== null;
}

export function elevenLabs(): ElevenLabsClient {
  if (!elevenLabsConfigured()) throw new ProviderError('not_configured', 'ElevenLabs is not set up on this server.', 503);
  client ??= new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY?.trim() || 'test',
    baseUrl: ELEVEN_API,
    maxRetries: 0,
    timeoutInSeconds: 30,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
  return client;
}

/**
 * A read-only GET for the free account checks (plan, permissions). The SDK validates every field of
 * these responses strictly, so a field ElevenLabs adds or drops would break detection; this reads
 * only what Atlas AI needs. The key comes from the server environment and is never returned.
 */
export async function elevenGetJson(path: string, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
  if (!elevenLabsConfigured()) throw new ProviderError('not_configured', 'ElevenLabs is not set up on this server.', 503);
  const res = await (fetchOverride ?? fetch)(`${ELEVEN_API}${path}`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY?.trim() || 'test', accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: the status is enough
  }
  return { status: res.status, body };
}

/** Credits a response reports (`character-cost` header), or null when absent. */
export function creditsOf(headers: Headers | undefined | null): number | null {
  const v = headers?.get('character-cost');
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read a short machine code from an ElevenLabs error body without keeping any of its text. */
function detailCode(body: unknown): string | null {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const code = (d as { code?: unknown; status?: unknown }).code ?? (d as { status?: unknown }).status;
    if (typeof code === 'string' && /^[a-z0-9_]{2,60}$/i.test(code)) return code;
  }
  return null;
}

const planRefusals = new WeakSet<object>();
/** True when ElevenLabs refused because the feature is not in the account's plan (not for lack of credits). */
export function isPlanRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && planRefusals.has(err);
}

/** Map anything the SDK throws to a ProviderError with a safe, user-facing message. */
export function mapElevenLabsError(err: unknown, signal?: AbortSignal): ProviderError | unknown {
  if (signal?.aborted) return err;
  if (err instanceof ProviderError) return err;
  if (err instanceof ElevenLabsTimeoutError) return new ProviderError('timeout', 'ElevenLabs took too long to respond.', 504);
  if (err instanceof ElevenLabsError) {
    const status = err.statusCode ?? 502;
    const code = detailCode(err.body);
    if (status === 401 && code === 'unauthorized') {
      return new ProviderError('model_unavailable', 'The ElevenLabs key does not allow this feature. An administrator needs to add the permission to the key.', 403);
    }
    if (status === 401) return new ProviderError('invalid_key', 'The ElevenLabs key was rejected. An administrator needs to check it.', 503);
    if (status === 402 || code === 'paid_plan_required' || code === 'feature_not_available' || code === 'feature_unavailable') {
      const e = new ProviderError('insufficient_credits', 'This ElevenLabs feature is not included in the current ElevenLabs plan (it needs a paid plan).', 402);
      planRefusals.add(e);
      return e;
    }
    if (status === 403) return new ProviderError('model_unavailable', 'The ElevenLabs account does not allow this feature.', 403);
    if (code === 'quota_exceeded') return new ProviderError('insufficient_credits', 'The ElevenLabs account has no credits left this month.', 402);
    if (status === 429) return new ProviderError('rate_limited', 'ElevenLabs is busy. Please try again in a moment.', 429);
    if (status === 404) return new ProviderError('model_unavailable', 'That ElevenLabs voice is not available.', 404);
    if (status === 400 || status === 422) return new ProviderError('bad_request', 'ElevenLabs could not process this request.', 400);
    // unexpected: keep the status and code (never the message or the key) in the server log for diagnosis
    console.warn('[elevenlabs] unexpected error', status, code ?? 'no_code');
    return new ProviderError('provider_error', 'ElevenLabs is unavailable right now. Please try again shortly.', 502);
  }
  return new ProviderError('provider_error', 'ElevenLabs is unavailable right now. Please try again shortly.', 502);
}
