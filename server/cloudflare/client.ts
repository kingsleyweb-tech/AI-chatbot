/**
 * Cloudflare Workers AI REST client (server-only).
 *
 * Credentials come from CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN and are
 * only ever placed in the Authorization header of requests made from the
 * server. They never appear in URLs that are logged, in error messages, or in
 * anything sent to the browser.
 *
 * Formats verified against the live API (2026-11):
 *  - errors: {success:false, errors:[{code, message}]}; 401 code 10000 = bad
 *    token/account; 400 code 7000 = unknown model route; 400 code 3030 = bad input
 *  - daily free allocation used up: code 4006 / "daily free allocation"
 *  - every response carries the exact cost in the `cf-ai-neurons` header
 */
import { env } from '../env.js';
import { ProviderError } from '../providers/types.js';

const API = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Scripted stand-in for local end-to-end tests only (installed by dev/api-plugin.ts when
 * E2E_FAKE_AI=1 on the dev server; never in a deployment). No request reaches Cloudflare.
 */
export interface CloudflareFake {
  image(model: string, body: { json?: Record<string, unknown>; form?: FormData }, signal?: AbortSignal): Promise<ImageRunResult>;
  chat(model: string, messages: { role: string; content: string }[]): Promise<{ text: string; neurons: number }>;
}
let fake: CloudflareFake | null = null;
export function setCloudflareFake(f: CloudflareFake | null) {
  fake = f;
}

export function cloudflareConfigured(): boolean {
  if (fake) return true;
  const e = env();
  return Boolean(e.cloudflareAccountId && e.cloudflareApiToken);
}

export function aiBase(): string {
  const id = env().cloudflareAccountId;
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new ProviderError('not_configured', 'Cloudflare Workers AI is not configured.', 500);
  return `${API}/${id}/ai`;
}

export function authHeader(): Record<string, string> {
  const token = env().cloudflareApiToken;
  if (!token) throw new ProviderError('not_configured', 'Cloudflare Workers AI is not configured.', 500);
  return { authorization: `Bearer ${token}` };
}

/** Free daily allocation (10,000 Neurons) used up: remembered in-process until 00:00 UTC. */
let dailyLimitUntil = 0;
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
export function markCloudflareDailyLimit(now = Date.now()) {
  dailyLimitUntil = nextUtcMidnight(now);
}
export function cloudflareDailyLimitActive(now = Date.now()): boolean {
  return now < dailyLimitUntil;
}
export function resetCloudflareDailyLimit() {
  dailyLimitUntil = 0;
}
export function cloudflareDailyLimitError(): ProviderError {
  return new ProviderError(
    'daily_limit',
    'The free daily Cloudflare Workers AI allowance has been used up. It resets at 00:00 UTC.',
    429,
  );
}

/** Map a Workers AI HTTP error to a typed ProviderError (never includes credentials). */
export function mapCloudflareError(status: number, body: string): ProviderError {
  let code = 0;
  let message: string;
  try {
    const parsed = JSON.parse(body) as { errors?: { code?: number; message?: string }[]; error?: { message?: string; code?: number } | string };
    const first = parsed.errors?.[0];
    code = Number(first?.code ?? (typeof parsed.error === 'object' ? parsed.error?.code : 0) ?? 0) || 0;
    message = String(first?.message ?? (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? '');
  } catch {
    message = body;
  }
  const lower = message.toLowerCase();
  if (code === 4006 || /daily free allocation|neurons? (limit|allocation)|upgrade to .*paid/.test(lower)) {
    markCloudflareDailyLimit();
    return cloudflareDailyLimitError();
  }
  if (status === 401 || status === 403 || code === 10000)
    return new ProviderError('invalid_key', 'Cloudflare Workers AI rejected the credentials.', 401);
  if (status === 429) return new ProviderError('rate_limited', 'Cloudflare Workers AI is rate-limited right now.', 429);
  if (code === 7000 || status === 404 || /no such model|model not found|no route/.test(lower))
    return new ProviderError('model_unavailable', 'This Cloudflare model is currently unavailable.', 404);
  if (/context|too many tokens|maximum.*tokens/.test(lower) && status === 400)
    return new ProviderError('context_too_long', 'The conversation is too long for this model.', 400);
  if (status === 408 || /timed? ?out/.test(lower)) return new ProviderError('timeout', 'The model took too long to respond.', 504);
  if (/capacity|overloaded|temporarily/.test(lower) || status >= 500)
    return new ProviderError('provider_error', 'Cloudflare Workers AI had a temporary problem.', 502);
  // keep the provider's reason (it never contains the token), but strip request ids
  const reason = message.replace(/\s*\([0-9a-f-]{20,}\)/gi, '').replace(/^(AiError:\s*)+/i, '').slice(0, 160);
  return new ProviderError('bad_request', `Cloudflare Workers AI rejected the request${reason ? `: ${reason}` : '.'}`, 400);
}

/** Exact cost of a response, from the `cf-ai-neurons` header (0 when absent). */
export function neuronsOf(res: Response): number {
  const n = Number(res.headers.get('cf-ai-neurons') ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface ImageRunResult {
  bytes: Uint8Array;
  mime: string;
  neurons: number;
}

const IMAGE_TIMEOUT_MS = 90_000;

/** Run an image model. Body is JSON or multipart, depending on the model. */
export async function runImageModel(model: string, body: { json?: Record<string, unknown>; form?: FormData }, signal?: AbortSignal): Promise<ImageRunResult> {
  if (fake) return fake.image(model, body, signal);
  const signals = [AbortSignal.timeout(IMAGE_TIMEOUT_MS), signal].filter(Boolean) as AbortSignal[];
  let res: Response;
  try {
    res = await fetch(`${aiBase()}/run/${model}`, {
      method: 'POST',
      headers: { ...authHeader(), ...(body.json ? { 'content-type': 'application/json' } : {}) },
      body: body.json ? JSON.stringify(body.json) : body.form,
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('timeout', 'The image model took too long to respond.', 504);
  }
  const neurons = neuronsOf(res);
  const text = await res.text();
  if (!res.ok) {
    const e = mapCloudflareError(res.status, text);
    (e as ProviderError & { neurons?: number }).neurons = neurons;
    throw e;
  }
  let image = '';
  try {
    const data = JSON.parse(text) as { result?: { image?: string }; success?: boolean; errors?: unknown[] };
    image = data.result?.image ?? '';
  } catch {
    /* handled below */
  }
  if (!image) throw new ProviderError('provider_error', 'The image model returned no image.', 502);
  const bytes = Uint8Array.from(Buffer.from(image, 'base64'));
  const mime = sniffImageMime(bytes);
  if (!mime) throw new ProviderError('provider_error', 'The image model returned an unreadable image.', 502);
  return { bytes, mime, neurons };
}

/** Detect the real format from the file signature (never trust a label). */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Pixel size from a JPEG/PNG/WebP header, or null. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }
  if (sniffImageMime(b) === 'image/webp') {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === 'VP8 ') return { width: ((b[27] << 8) | b[26]) & 0x3fff, height: ((b[29] << 8) | b[28]) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/** One non-streaming OpenAI-compatible chat completion (used for the safety check). */
export async function chatOnce(model: string, messages: { role: string; content: string }[], opts: { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ text: string; neurons: number }> {
  if (fake) return fake.chat(model, messages);
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 20_000), opts.signal].filter(Boolean) as AbortSignal[];
  let res: Response;
  try {
    res = await fetch(`${aiBase()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 20, stream: false }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('timeout', 'The model did not respond in time.', 504);
  }
  const text = await res.text();
  if (!res.ok) throw mapCloudflareError(res.status, text);
  const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[]; usage?: { neurons?: number } };
  return { text: data.choices?.[0]?.message?.content ?? '', neurons: neuronsOf(res) || Number(data.usage?.neurons ?? 0) || 0 };
}
