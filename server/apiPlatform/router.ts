/**
 * The Atlas AI API, version 1 (/api/v1/...). Served by api/models.ts through a rewrite in
 * vercel.json (the Hobby plan allows 12 functions and all 12 are in use).
 *
 * Every request goes through the same steps, in this order:
 *  1. authenticate the key (auth.ts) and check the browser origin
 *  2. derive the end user's data space from the integration + X-Atlas-User
 *  3. pin the integration's API environment (env.ts): a later switch never affects this request
 *  4. idempotency (Idempotency-Key header, POST only)
 *  5. request-rate limits and concurrency (limits.ts), then the endpoint's own permission and
 *     feature-quota checks
 *  6. run the endpoint, answer with the standard JSON envelope (or a stream), log the outcome
 *
 * Responses never contain stack traces, provider credentials, internal settings or other
 * applications' data.
 */
import { z } from 'zod';
import { adminConfigured, adminDb } from '../admin.js';
import { runPinned } from '../environments/index.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { ProviderError } from '../providers/types.js';
import { API_VERSION, type ApiFeature, type IntegrationConfig } from '../shared/apiPlatform.js';
import { authenticate, corsHeaders, preflight } from './auth.js';
import { apiEventStream, chatInput, collectChat, createConversation, listModels, startChat, type ChatResult, type ChatRun } from './chat.js';
import { need, type ApiCall } from './context.js';
import { integrationPin } from './env.js';
import {
  analyzeInput,
  analyzeMessage,
  createImage,
  deleteDocument,
  deleteMemory,
  documentInput,
  getConversation,
  getDocument,
  imageInput,
  listConversations,
  listDocuments,
  listMemories,
  removeConversation,
  researchInput,
  speech,
  speechInput,
  transcription,
  uploadDocument,
  webSearch,
} from './features.js';
import { newId, shortHash } from './keys.js';
import { acquireSlot, ApiLimitError, beginIdempotent, countRequest, IDEMPOTENCY_RE, type RateInfo } from './limits.js';
import { endpointPattern, recordOutcome, touchLastUsed } from './log.js';
import { APP_USER, END_USER_RE, END_USERS, endUserUid, type KeyRecord } from './store.js';

/* --------------------------------------------------------------------- routing */

type Handler = (call: ApiCall) => Promise<HandlerResult>;

/** JSON data (wrapped in the envelope) or a finished response (stream, audio). */
type HandlerResult =
  | { data: unknown; status?: number; conversationId?: string | null; usage?: unknown }
  /** a binary response (audio), passed through as it is produced */
  | { response: Response }
  /** a chat turn streamed as Server-Sent Events */
  | { stream: ChatRun };

interface Route {
  feature: ApiFeature;
  /** request body: JSON with this size limit, 'raw' (audio) or none */
  body: number | 'raw' | null;
  run: Handler;
}

const JSON_SMALL = 100_000;
const JSON_LARGE = 4_400_000;

const conversationCreate = z.object({ title: z.string().max(80).optional() }).strict();

async function bodyOf<T>(call: ApiCall, schema: z.ZodType<T>, max: number): Promise<T> {
  const len = Number(call.request.headers.get('content-length') ?? 0);
  if (len > max) throw new HttpError(413, 'too_large', 'The request body is too large.');
  const text = await call.request.text();
  if (text.length > max) throw new HttpError(413, 'too_large', 'The request body is too large.');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body must be valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, 'invalid_request', `Invalid request: ${where}${issue?.message ?? 'unknown'}`.slice(0, 300));
  }
  return parsed.data;
}


function chatEnvelope(call: ApiCall, r: ChatResult): HandlerResult {
  if (r.error && !r.content.trim() && !r.images.length) {
    const capacity = r.error.code === 'provider_capacity';
    call.meta.providerError = capacity || r.error.code === 'provider_error';
    const status = capacity ? 503 : r.error.code === 'provider_error' ? 502 : r.error.code.endsWith('_limit') || r.error.code === 'image_busy' ? 429 : 422;
    throw new HttpError(status, r.error.code, r.error.message, { conversation_id: r.conversation_id, message_id: r.message_id });
  }
  if (r.model) call.meta.model = r.model;
  const { usage, ...data } = r;
  return { data, conversationId: r.conversation_id, usage: usage ? { tokens: usage } : null };
}

/** Streaming chat or research: start the turn first, so permission errors are plain JSON. */
async function chatTurn(call: ApiCall, stream: boolean | undefined, start: () => Promise<ChatRun>): Promise<HandlerResult> {
  if (stream) {
    need(call, 'chat_stream');
    if (!call.integration.limits.streaming) throw new HttpError(403, 'streaming_not_allowed', 'Streaming is not enabled for this application.');
  }
  const run = await start();
  return stream ? { stream: run } : chatEnvelope(call, await collectChat(run));
}

function route(call: ApiCall): Route | null {
  const [a, b, c, d] = call.segments;
  const m = call.method;
  if (d !== undefined) return null;
  switch (a) {
    case 'app':
      if (m === 'GET' && !b) return { feature: 'app', body: null, run: async () => ({ data: appInfo(call.integration, call.key) }) };
      return null;
    case 'models':
      if (m === 'GET' && !b)
        return {
          feature: 'models',
          body: null,
          run: async () => {
            need(call, 'chat');
            return { data: await listModels(call) };
          },
        };
      return null;
    case 'chat':
      if (m === 'POST' && !b)
        return {
          feature: 'chat',
          body: JSON_LARGE,
          run: async (call) => {
            const input = await bodyOf(call, chatInput, JSON_LARGE);
            return chatTurn(call, input.stream, () => startChat(call, input));
          },
        };
      return null;
    case 'conversations':
      if (!b && m === 'GET') return { feature: 'conversations', body: null, run: async () => ({ data: await listConversations(call) }) };
      if (!b && m === 'POST')
        return {
          feature: 'conversations',
          body: JSON_SMALL,
          run: async (call) => {
            need(call, 'chat');
            const input = await bodyOf(call, conversationCreate, JSON_SMALL);
            const id = await createConversation(call, input.title);
            return { data: { conversation: { id, title: input.title?.trim() || 'New chat', message_count: 0 } }, status: 201, conversationId: id };
          },
        };
      if (b && !c && m === 'GET') return { feature: 'conversations', body: null, run: async () => ({ data: await getConversation(call, b), conversationId: b }) };
      if (b && !c && m === 'DELETE') return { feature: 'conversations', body: null, run: async () => ({ data: await removeConversation(call, b), conversationId: b }) };
      return null;
    case 'images':
      if (m === 'POST' && !b)
        return {
          feature: 'images',
          body: JSON_LARGE,
          run: async (call) => {
            const input = await bodyOf(call, imageInput, JSON_LARGE);
            return { data: await createImage(call, input), status: 201 };
          },
        };
      return null;
    case 'research':
      if (m === 'POST' && !b)
        return {
          feature: 'research',
          body: JSON_SMALL,
          run: async (call) => {
            const input = await bodyOf(call, researchInput, JSON_SMALL);
            const mode = input.mode ?? 'answer';
            if (mode === 'search') return { data: await webSearch(call, input.query) };
            need(call, 'research');
            if (mode === 'deep') need(call, 'deep_research');
            return chatTurn(call, input.stream, () =>
              startChat(
                call,
                { message: input.query, conversation_id: input.conversation_id, stream: input.stream },
                { forceWeb: 'on', forceDeep: mode === 'deep', documentsOnly: true },
              ),
            );
          },
        };
      return null;
    case 'documents':
      if (!b && m === 'POST')
        return {
          feature: 'documents',
          body: JSON_LARGE,
          run: async (call) => ({ data: await uploadDocument(call, await bodyOf(call, documentInput, JSON_LARGE)), status: 201 }),
        };
      if (!b && m === 'GET') return { feature: 'documents', body: null, run: async () => ({ data: await listDocuments(call) }) };
      if (b && !c && m === 'GET') return { feature: 'documents', body: null, run: async () => ({ data: await getDocument(call, b) }) };
      if (b && !c && m === 'DELETE') return { feature: 'documents', body: null, run: async () => ({ data: await deleteDocument(call, b) }) };
      if (b && c === 'analyze' && m === 'POST')
        return {
          feature: 'documents',
          body: JSON_SMALL,
          run: async (call) => {
            const input = await bodyOf(call, analyzeInput, JSON_SMALL);
            const message = await analyzeMessage(call, b, input);
            return chatTurn(call, input.stream, () =>
              startChat(
                call,
                { message, conversation_id: input.conversation_id, model: input.model, document_ids: [b], web_search: 'off', stream: input.stream },
                { documentsOnly: true },
              ),
            );
          },
        };
      return null;
    case 'voice':
      if (b === 'speech' && !c && m === 'POST')
        return {
          feature: 'voice',
          body: JSON_SMALL,
          run: async (call) => ({ response: await speech(call, await bodyOf(call, speechInput, JSON_SMALL)) }),
        };
      if (b === 'transcriptions' && !c && m === 'POST') return { feature: 'voice', body: 'raw', run: async (call) => ({ data: await transcription(call, call.request) }) };
      return null;
    case 'memory':
      if (!b && m === 'GET') return { feature: 'memory', body: null, run: async () => ({ data: await listMemories(call) }) };
      if (!b && m === 'DELETE') return { feature: 'memory', body: null, run: async () => ({ data: await deleteMemory(call, null) }) };
      if (b && !c && m === 'DELETE') return { feature: 'memory', body: null, run: async () => ({ data: await deleteMemory(call, b) }) };
      return null;
    default:
      return null;
  }
}

/** What an application may learn about itself (no keys, hashes or other applications). */
export function appInfo(i: IntegrationConfig, k: KeyRecord) {
  return {
    app_id: i.id,
    name: i.name,
    app_name: i.appName,
    app_type: i.appType,
    status: i.status,
    permissions: i.permissions,
    profile: i.profile,
    limits: i.limits,
    key: { id: k.id, mode: k.mode, display: k.display, limits: k.limits, expires_at: k.expiresAt },
    expires_at: i.expiresAt,
    api_version: API_VERSION,
  };
}

/* ------------------------------------------------------------------- responses */

interface Envelope {
  success: boolean;
  request_id: string;
  api_version: string;
  app_id: string | null;
  conversation_id: string | null;
  data: unknown;
  usage: unknown;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  rate_limit: { limit: number; remaining: number; reset: string; window: string } | null;
}

function rateHeaders(rate: RateInfo | null): Record<string, string> {
  if (!rate) return {};
  return {
    'x-ratelimit-limit': String(rate.limit),
    'x-ratelimit-remaining': String(rate.remaining),
    'x-ratelimit-reset': String(Math.ceil(rate.reset / 1000)),
  };
}

const rateBody = (rate: RateInfo | null) => (rate ? { limit: rate.limit, remaining: rate.remaining, reset: new Date(rate.reset).toISOString(), window: rate.window } : null);

/** Error codes whose message is written for applications (others above 499 get a generic text). */
const OWN_5XX = new Set(['environment_not_permitted', 'environment_unavailable', 'provider_unavailable', 'provider_capacity', 'provider_error', 'search_unavailable', 'speech_unavailable', 'images_unavailable', 'api_unavailable']);

/** Details safe to return (machine-readable limits and ids only). */
const SAFE_DETAILS = new Set(['permission', 'limit', 'window', 'resetsAt', 'feature', 'conversation_id', 'message_id']);

export function errorOf(err: unknown): { status: number; code: string; message: string; details?: Record<string, unknown>; providerError: boolean } {
  if (err instanceof HttpError) {
    const internal = err.status >= 500 && !OWN_5XX.has(err.code);
    const details = Object.fromEntries(Object.entries(err.details ?? {}).filter(([k]) => SAFE_DETAILS.has(k)));
    return {
      status: err.status,
      code: internal ? 'server_error' : err.code,
      message: internal ? 'Atlas AI could not complete this request. Please try again later.' : err.message,
      ...(Object.keys(details).length && !internal ? { details } : {}),
      providerError: err.code.startsWith('provider_'),
    };
  }
  if (err instanceof ProviderError) {
    return { status: 502, code: 'provider_error', message: 'The AI provider could not complete this request. Please try again.', providerError: true };
  }
  console.error('[api/v1] unexpected error:', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
  return { status: 500, code: 'server_error', message: 'Atlas AI could not complete this request. Please try again later.', providerError: false };
}

/* --------------------------------------------------------------------- request */

export interface V1Options {
  /** waitUntil: background work that must finish after the response */
  background?: (p: Promise<unknown>) => void;
  /** the Super Admin test console: already authorised, the key's secret is not needed */
  preauthenticated?: { integration: IntegrationConfig; key: KeyRecord };
  db?: Firestore;
  now?: () => number;
}

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** Handle one /api/v1 request. `path` is the part after /v1/ (from the rewrite). */
export async function handleV1(request: Request, path: string, opts: V1Options = {}): Promise<Response> {
  const t0 = Date.now();
  const requestId = newId('req', 12);
  const method = request.method.toUpperCase();
  const background = opts.background ?? ((p: Promise<unknown>) => void p.catch(() => undefined));
  if (method === 'OPTIONS') return preflight(request);

  const segments = path.split('/').filter(Boolean);
  const baseHeaders: Record<string, string> = { 'x-request-id': requestId, 'atlas-api-version': API_VERSION, 'cache-control': 'no-store' };
  let extraHeaders: Record<string, string> = {};
  let integration: IntegrationConfig | null = null;
  let key: KeyRecord | null = null;
  let rate: RateInfo | null = null;
  let counted = false;
  let environment: ApiCall['environment'] | null = null;
  let feature: ApiFeature = 'app';
  const meta: ApiCall['meta'] = { feature, model: null, providerError: false, units: [] };
  let db: Firestore | null = null;
  const source: ApiCall['source'] = opts.preauthenticated ? 'admin_test' : 'api';

  const finish = (status: number, code: string | null) => {
    if (!db) return;
    const d = db;
    background(
      Promise.all([
        recordOutcome(d, {
          integrationId: integration?.id ?? '',
          keyId: key?.id ?? null,
          mode: key?.mode ?? null,
          method,
          endpoint: endpointPattern(segments),
          feature: meta.feature,
          status,
          code,
          ms: Date.now() - t0,
          environment,
          model: meta.model,
          requestId,
          source,
          counted,
          providerError: meta.providerError,
        }),
        integration && key && status < 500 && status !== 401 ? touchLastUsed(d, integration.id, key.id) : Promise.resolve(),
      ]).catch((err) => console.warn('[api/v1] could not record the request', err instanceof Error ? err.message : err)),
    );
  };

  const envelope = (status: number, body: Omit<Envelope, 'request_id' | 'api_version' | 'app_id' | 'rate_limit'>, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ ...body, request_id: requestId, api_version: API_VERSION, app_id: integration?.id ?? null, rate_limit: rateBody(rate) }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders, ...rateHeaders(rate), ...extraHeaders, ...headers },
    });

  const fail = (err: unknown): Response => {
    const e = errorOf(err);
    if (e.providerError) meta.providerError = true;
    const headers: Record<string, string> = {};
    if (err instanceof ApiLimitError) {
      headers['retry-after'] = String(err.retryAfter);
      if (err.rate) rate = err.rate;
    }
    if (e.status === 401) headers['www-authenticate'] = 'Bearer realm="atlas-ai"';
    finish(e.status, e.code);
    return envelope(e.status, { success: false, conversation_id: null, data: null, usage: null, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, headers);
  };

  try {
    if (!adminConfigured()) throw new HttpError(503, 'api_unavailable', 'The Atlas AI API is not available right now.');
    db = opts.db ?? (await adminDb());
    if (segments.length > 4 || !segments.every((s) => SEGMENT.test(s))) throw new HttpError(404, 'not_found', 'Unknown endpoint.');

    // 1. who is calling
    const auth = opts.preauthenticated ?? (await authenticate(db, request));
    integration = auth.integration;
    key = auth.key;
    if (!opts.preauthenticated) extraHeaders = corsHeaders(request, integration);

    // 2. the end user (scoped to this integration; never another application's users)
    const endUser = request.headers.get('x-atlas-user')?.trim() || APP_USER;
    if (endUser !== APP_USER && !END_USER_RE.test(endUser)) throw new HttpError(400, 'invalid_user', 'X-Atlas-User must be 1-128 characters: letters, digits and . _ : @ -');
    const euid = endUserUid(integration.id, endUser);

    // 3. the environment, pinned for the whole request
    const ip = integrationPin(integration, key.mode);
    environment = ip.environment;

    const call: ApiCall = {
      requestId,
      db,
      integration,
      key,
      scope: { integration, key },
      euid,
      endUser,
      environment,
      source,
      request,
      method,
      segments,
      query: new URL(request.url).searchParams,
      signal: request.signal,
      background,
      rate: null,
      meta,
    };
    const r = route(call);
    if (!r) throw new HttpError(404, 'not_found', 'Unknown endpoint.');
    feature = r.feature;
    meta.feature = feature;

    return await runPinned(ip.pin, async () => {
      const d = db as Firestore;
      // 4. idempotency (writes only)
      const idemKey = request.headers.get('idempotency-key');
      let idem: Awaited<ReturnType<typeof beginIdempotent>> | null = null;
      if (idemKey && method !== 'GET') {
        if (!IDEMPOTENCY_RE.test(idemKey)) throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-128 characters: letters, digits and . _ : -');
        if (r.body === 'raw') throw new HttpError(400, 'idempotency_unsupported', 'Idempotency-Key is not supported for audio uploads.');
        const bodyText = r.body === null ? '' : await request.clone().text();
        const fingerprint = shortHash(`${method} ${path} ${euid} ${bodyText}`, 40);
        idem = await beginIdempotent(d, integration!.id, `${key!.id}:${idemKey}`, fingerprint);
        if (idem.kind === 'replay') {
          const s = idem.stored;
          finish(s.status, 'idempotent_replay');
          if (s.body === null) return envelope(s.status, { success: s.status < 400, conversation_id: null, data: null, usage: null, error: null }, { 'idempotent-replayed': 'true' });
          return new Response(s.body, { status: s.status, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders, ...extraHeaders, 'idempotent-replayed': 'true' } });
        }
      }

      // 5. request rate and concurrency
      let release: (() => Promise<void>) | null = null;
      try {
        rate = await countRequest(d, call.scope);
        counted = true;
        call.rate = rate;
        release = await acquireSlot(d, call.scope);
      } catch (err) {
        if (idem?.kind === 'new') await idem.abandon();
        throw err;
      }
      // register this end user (for deletion and isolation reviews; no personal data)
      if (endUser !== APP_USER) background(d.set(`${END_USERS}/${euid}`, { integrationId: integration!.id, ref: shortHash(endUser, 16), lastSeenAt: Date.now() }, true));

      // 6. run
      let result: HandlerResult;
      try {
        result = await r.run(call);
      } catch (err) {
        await release();
        const res = fail(err);
        if (idem?.kind === 'new') {
          const text = await res.clone().text();
          await idem.finish(res.status, text);
        }
        return res;
      }

      if ('stream' in result) {
        // the stream ends later: the slot is released and the outcome logged then
        const run = result.stream;
        const stream = apiEventStream(
          run,
          { request_id: requestId, api_version: API_VERSION, app_id: integration!.id, conversation_id: run.conversationId, message_id: run.messageId, rate_limit: rateBody(rate) },
          ({ error }) => {
            void release!();
            if (error && (error.code === 'provider_error' || error.code === 'provider_capacity')) meta.providerError = true;
            // the HTTP status was already 200; analytics record the failure the stream reported
            finish(error ? (error.code === 'provider_capacity' ? 503 : error.code === 'provider_error' ? 502 : 422) : 200, error?.code ?? null);
          },
        );
        if (idem?.kind === 'new') await idem.abandon();
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            ...baseHeaders,
            ...rateHeaders(rate),
            ...extraHeaders,
          },
        });
      }
      if ('response' in result) {
        // binary (audio): passed through as it is produced
        const res = result.response;
        const body = res.body;
        if (!body) {
          await release();
          finish(res.status, null);
          return res;
        }
        const reader = body.getReader();
        let done = false;
        const end = () => {
          if (done) return;
          done = true;
          void release!();
          finish(res.status, null);
        };
        const passthrough = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                end();
              } else controller.enqueue(chunk.value);
            } catch (err) {
              end();
              controller.error(err);
            }
          },
          cancel(reason) {
            end();
            return reader.cancel(reason);
          },
        });
        if (idem?.kind === 'new') await idem.abandon();
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries({ ...baseHeaders, ...rateHeaders(rate), ...extraHeaders })) headers.set(k, v);
        return new Response(passthrough, { status: res.status, headers });
      }

      await release();
      const status = result.status ?? 200;
      finish(status, null);
      const res = envelope(status, { success: true, conversation_id: result.conversationId ?? null, data: result.data, usage: result.usage ?? null, error: null });
      if (idem?.kind === 'new') await idem.finish(status, await res.clone().text());
      return res;
    });
  } catch (err) {
    return fail(err);
  }
}

