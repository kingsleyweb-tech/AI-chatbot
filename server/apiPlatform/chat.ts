/**
 * AI chat for connected applications, on the same engine as the website (server/chat/engine.ts):
 * the same model routing and fallbacks, Advanced Reasoning pathway, web search and Deep Research,
 * documents, memory, image requests, safety rules and provider safeguards. Nothing is duplicated.
 *
 * Differences for applications:
 * - Data lives in the end user's own space users/{euid} (see store.ts), so applications and their
 *   users are isolated from each other and from website accounts.
 * - Conversations created through the API carry apiIntegrationId; any other conversation is "not
 *   found" for the API.
 * - The application's own permissions and limits apply (ctx.api), never a person's allowance.
 * - The shared knowledge base (Atlas AI's own documents) is not used for applications.
 */
import { z } from 'zod';
import type { Ctx } from '../access.js';
import { chatRequestSchema, runChat } from '../chat/engine.js';
import { loadAiConfig } from '../config/ai.js';
import { SERVER_TIME } from '../firestore.js';
import { HttpError } from '../http.js';
import { getCatalog } from '../providers/registry.js';
import { thinkingSwitchable } from '../router/pathway.js';
import { ProviderError } from '../providers/types.js';
import type { ChatRequestBody, ModelInfo, StreamEvent } from '../shared/types.js';
import type { FeatureId, FeatureView } from '../usage/policy.js';
import type { Reservation } from '../usage/allowance.js';
import { has, need, sizeLimit, type ApiCall } from './context.js';
import { newId } from './keys.js';
import { claimUnits, readNum, dayStatsPath, type UnitClaim } from './limits.js';
import { utcDay } from '../environments/index.js';

export const CONV_ID = /^conv_[a-f0-9]{16}$/;
export const DOC_ID = /^doc_[a-f0-9]{16}$/;

export const convPath = (euid: string, id: string) => `users/${euid}/conversations/${id}`;

/* ------------------------------------------------------------------ input */

export const chatInput = z
  .object({
    message: z.string().min(1).max(200_000),
    conversation_id: z.string().regex(CONV_ID).optional(),
    model: z.string().min(1).max(200).optional(),
    stream: z.boolean().optional(),
    web_search: z.enum(['off', 'auto', 'on']).optional(),
    deep_research: z.boolean().optional(),
    memory: z.boolean().optional(),
    document_ids: z.array(z.string().regex(DOC_ID)).max(10).optional(),
    images: z
      .array(
        z.object({
          data_url: z
            .string()
            .max(1_500_000)
            .regex(/^data:image\/(png|jpe?g|webp|gif);base64,/),
          name: z.string().max(200).optional(),
        }),
      )
      .max(4)
      .optional(),
    include_reasoning: z.boolean().optional(),
    title: z.string().max(80).optional(),
  })
  .strict();
export type ChatInput = z.infer<typeof chatInput>;

/** Model "auto" (or none): the administrator's default model, else the catalog default. */
export async function resolveModel(call: ApiCall, requested: string | undefined): Promise<{ id: string; info: ModelInfo | undefined; auto: boolean }> {
  const catalog = await getCatalog().catch((err) => {
    if (err instanceof ProviderError) throw new HttpError(503, 'provider_unavailable', 'The AI models are temporarily unavailable. Please try again shortly.');
    throw err;
  });
  if (!requested || requested === 'auto') {
    const ai = await loadAiConfig(call.db);
    const id = ai.defaultModel && catalog.models.some((m) => m.id === ai.defaultModel) ? ai.defaultModel : catalog.defaultModel;
    return { id, info: catalog.models.find((m) => m.id === id), auto: true };
  }
  need(call, 'models');
  const info = catalog.models.find((m) => m.id === requested);
  if (call.integration.allowedModels && !call.integration.allowedModels.includes(requested)) {
    throw new HttpError(403, 'model_not_allowed', 'This model is not permitted for this application.');
  }
  // free models only: an application can never select a paid model
  if (!info || !info.free || !info.available) throw new HttpError(400, 'model_unavailable', 'This model is not available. Use "auto" or a model from GET /v1/models.');
  if (info.capabilities.reasoning && !thinkingSwitchable(info.id) && !has(call, 'reasoning')) {
    throw new HttpError(403, 'permission_denied', 'This model always uses advanced reasoning, which this application is not permitted to use.', { permission: 'reasoning' });
  }
  return { id: info.id, info, auto: false };
}

/** The models an application may select (free, available, within its allowed list). */
export async function listModels(call: ApiCall) {
  const catalog = await getCatalog();
  const ai = await loadAiConfig(call.db).catch(() => null);
  const allowed = call.integration.allowedModels;
  return {
    default: 'auto',
    auto_model: ai?.defaultModel && catalog.models.some((m) => m.id === ai.defaultModel) ? ai.defaultModel : catalog.defaultModel,
    selectable: has(call, 'models'),
    models: catalog.models
      .filter((m) => m.free && m.available && (!allowed || allowed.includes(m.id)))
      .filter((m) => has(call, 'reasoning') || !(m.capabilities.reasoning && !thinkingSwitchable(m.id)))
      .map((m) => ({
        id: m.id,
        name: m.name,
        vendor: m.vendor,
        context_length: m.contextLength,
        vision: m.capabilities.vision,
        reasoning: m.capabilities.reasoning,
      })),
  };
}

/* ------------------------------------------------------------ conversations */

export interface ConversationRow {
  id: string;
  title: string;
  message_count: number;
  created_at: string | null;
  updated_at: string | null;
}

const iso = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return null;
};

export function conversationRow(id: string, d: Record<string, unknown>): ConversationRow {
  return {
    id,
    title: typeof d.title === 'string' ? d.title : 'New chat',
    message_count: typeof d.messageCount === 'number' ? d.messageCount : 0,
    created_at: iso(d.createdAt),
    updated_at: iso(d.updatedAt),
  };
}

/** A conversation of this application's end user, or 404 (never another application's). */
export async function loadConversation(call: ApiCall, id: string): Promise<Record<string, unknown>> {
  if (!CONV_ID.test(id)) throw new HttpError(404, 'not_found', 'Conversation not found.');
  const doc = await call.db.get<Record<string, unknown>>(convPath(call.euid, id));
  if (!doc || doc.data.apiIntegrationId !== call.integration.id) throw new HttpError(404, 'not_found', 'Conversation not found.');
  return doc.data;
}

export async function createConversation(call: ApiCall, title: string | undefined): Promise<string> {
  const id = newId('conv');
  await call.db.commit([
    {
      op: 'set',
      path: convPath(call.euid, id),
      precondition: { exists: false },
      data: {
        title: (title?.trim() || 'New chat').slice(0, 80),
        titleSet: Boolean(title?.trim()),
        projectId: null,
        saved: false,
        model: null,
        documentIds: [],
        messageCount: 0,
        apiIntegrationId: call.integration.id,
        createdAt: SERVER_TIME,
        updatedAt: SERVER_TIME,
      },
    },
  ]);
  return id;
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  model: string | null;
  sources: { index: number; title: string; url: string; kind: string }[];
  images: { id: string; mime: string; width: number; height: number }[];
  created_at: string | null;
}

export function messageRow(id: string, d: Record<string, unknown>): MessageRow {
  const sources = Array.isArray(d.sources) ? (d.sources as Record<string, unknown>[]) : [];
  const images = Array.isArray(d.images) ? (d.images as Record<string, unknown>[]) : [];
  return {
    id,
    role: d.role === 'assistant' ? 'assistant' : 'user',
    content: typeof d.content === 'string' ? d.content : '',
    status: typeof d.status === 'string' ? d.status : 'complete',
    model: typeof d.model === 'string' ? d.model : null,
    sources: sources
      .filter((s) => s.kind === 'web')
      .map((s) => ({ index: Number(s.index) || 0, title: String(s.title ?? ''), url: String(s.url ?? ''), kind: String(s.kind) })),
    images: images.map((i) => ({ id: String(i.id ?? ''), mime: String(i.mime ?? ''), width: Number(i.width) || 0, height: Number(i.height) || 0 })),
    created_at: iso(d.createdAt),
  };
}

export async function loadMessages(call: ApiCall, conversationId: string, limit = 80): Promise<MessageRow[]> {
  const rows = await call.db.list<Record<string, unknown>>(`${convPath(call.euid, conversationId)}/messages`, {
    orderBy: 'createdAt',
    direction: 'DESCENDING',
    limit,
  });
  // oldest first; a question and its reply saved in the same instant keep question-then-reply order
  return rows
    .map((r) => messageRow(r.id, r.data))
    .reverse()
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1));
}

/* ------------------------------------------------------------------- chat */

/** A FeatureView stand-in: applications have no per-person allowance (the engine only displays it). */
function apiView(f: FeatureId): FeatureView {
  const period = { used: 0, limit: null, remaining: null, resetsAt: 0, key: '' };
  return { id: f, label: f, explain: '', limited: false, daily: period, weekly: period, percent: null, binding: null, exhausted: false };
}

export interface ChatRun {
  conversationId: string;
  messageId: string;
  /** the engine's Server-Sent Events */
  response: Response;
  includeReasoning: boolean;
}

/**
 * Start one chat turn: validate, check permissions and limits, store the user message, then hand
 * over to the engine. Errors before the engine accepts the turn are thrown (and nothing is stored
 * beyond the user message).
 */
export async function startChat(call: ApiCall, input: ChatInput, opts: { messageId?: string; forceWeb?: 'on'; forceDeep?: boolean; documentsOnly?: boolean } = {}): Promise<ChatRun> {
  if (!opts.documentsOnly) need(call, 'chat');
  const maxInput = sizeLimit(call, 'maxInputChars');
  if (input.message.length > maxInput) throw new HttpError(413, 'input_too_large', `The message is too long (limit ${maxInput} characters).`, { limit: maxInput });

  const deep = Boolean(opts.forceDeep ?? input.deep_research);
  const webMode = opts.forceWeb ?? input.web_search ?? (has(call, 'research') ? 'auto' : 'off');
  if (deep) need(call, 'deep_research');
  if (webMode !== 'off') need(call, 'research');
  const docIds = input.document_ids ?? [];
  if (docIds.length) need(call, 'documents');
  const memory = input.memory ?? has(call, 'memory');
  if (input.memory) need(call, 'memory');

  const model = await resolveModel(call, input.model);
  if (input.images?.length && model.info && !model.info.capabilities.vision && !model.auto) {
    throw new HttpError(400, 'unsupported_input', 'The selected model cannot read images. Use "auto" or a vision model.');
  }

  // documents must belong to this end user of this application
  if (docIds.length) {
    const docs = await call.db.getMany<Record<string, unknown>>(docIds.map((d) => `users/${call.euid}/documents/${d}`));
    const ok = new Set(docs.filter((d) => d.data.apiIntegrationId === call.integration.id).map((d) => d.id));
    const missing = docIds.find((d) => !ok.has(d));
    if (missing) throw new HttpError(404, 'not_found', `Document not found: ${missing}.`);
  }

  // web research quota: an explicit search or Deep Research is claimed up front (refused when used up);
  // an automatic search is only allowed while the quota lasts
  const claims: UnitClaim[] = [];
  let webAllowed = webMode !== 'off';
  if (deep) claims.push(await claimUnits(call.db, call.scope, 'deep_research'));
  else if (webMode === 'on') claims.push(await claimUnits(call.db, call.scope, 'research'));
  else if (webMode === 'auto') webAllowed = await researchLeft(call);
  call.meta.units.push(...claims);
  const preclaimed = claims.length > 0;

  // conversation: continue one of this application's, or start a new one
  let conversationId = input.conversation_id;
  let history: MessageRow[] = [];
  if (conversationId) {
    await loadConversation(call, conversationId);
    history = (await loadMessages(call, conversationId, 79)).filter((m) => m.content.trim() && (m.status === 'complete' || m.role === 'user'));
  } else {
    conversationId = await createConversation(call, input.title);
  }

  // store the user message (as the website's browser does), then the engine stores the reply
  const userMsgId = newId('msg');
  const attachments = (input.images ?? []).map((img, i) => ({ kind: 'image' as const, name: img.name ?? `image-${i + 1}`, mime: img.data_url.slice(5, img.data_url.indexOf(';')), dataUrl: img.data_url }));
  await call.db.commit([
    {
      op: 'set',
      path: `${convPath(call.euid, conversationId)}/messages/${userMsgId}`,
      data: { role: 'user', content: input.message, attachments: attachments.map(({ dataUrl: _d, ...a }) => (void _d, a)), status: 'complete', createdAt: SERVER_TIME },
    },
    { op: 'increment', path: convPath(call.euid, conversationId), increments: { messageCount: 1 }, data: { updatedAt: SERVER_TIME } },
  ]);

  const messageId = opts.messageId ?? newId('msg');
  const body: ChatRequestBody = {
    conversationId,
    assistantMessageId: messageId,
    model: model.id,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: input.message, ...(attachments.length ? { attachments } : {}) },
    ],
    options: {
      webSearch: webMode === 'on',
      searchMode: webMode === 'auto' ? 'auto' : 'manual',
      deepResearch: deep,
      memory,
      approvedPaidModel: null,
      documentIds: docIds,
    },
  };
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid chat request.');

  const maxOut = sizeLimit(call, 'maxOutputTokens');
  const ctx: Ctx = {
    user: { uid: call.euid, email: null, emailVerified: false, provider: 'api', phoneVerified: false, authTime: Math.floor(Date.now() / 1000), token: '' },
    db: call.db,
    admin: false,
    api: {
      integrationId: call.integration.id,
      images: has(call, 'images'),
      reasoning: has(call, 'reasoning'),
      maxOutputTokens: maxOut,
      web: webAllowed,
      onWebSearch(research: boolean) {
        // explicit searches were claimed above; automatic ones are counted when they happen
        if (preclaimed) return;
        call.background(claimUnits(call.db, call.scope, research ? 'deep_research' : 'research').then((c) => call.meta.units.push(c), () => undefined));
      },
      async reserve(f: FeatureId): Promise<Reservation> {
        const claim = f === 'images' ? await claimUnits(call.db, call.scope, 'images') : null;
        if (claim) call.meta.units.push(claim);
        return {
          feature: f,
          cost: 1,
          counted: true,
          view: apiView(f),
          settle: async () => undefined,
          release: async () => {
            await claim?.release();
          },
        };
      },
    },
  };
  call.meta.model = model.id;
  const response = await runChat(ctx, parsed.data as ChatRequestBody, call.signal, (p) => call.background(p));
  return { conversationId, messageId, response, includeReasoning: Boolean(input.include_reasoning) && has(call, 'reasoning') };
}

/** Whether the application's daily web-search quota still has room (only read when a limit is set). */
async function researchLeft(call: ApiCall): Promise<boolean> {
  const a = call.integration.limits.researchPerDay;
  const k = call.key.limits?.researchPerDay ?? null;
  if (a === null && k === null) return true;
  const doc = await call.db.get<Record<string, unknown>>(dayStatsPath(utcDay()));
  const usedA = readNum(doc?.data, `apps.${call.integration.id}.u.research`);
  const usedK = readNum(doc?.data, `keys.${call.key.id}.u.research`);
  return (a === null || usedA < a) && (k === null || usedK < k);
}

/* ------------------------------------------------- engine stream -> API events */

/** Provider error codes whose message is safe to pass on as written. */
const SAFE_ERROR_CODES = new Set([
  'rate_limited',
  'daily_limit',
  'free_limit',
  'context_too_long',
  'unsupported_input',
  'environment_limit',
  'content_filtered',
  'safety',
  'image_blocked',
  'image_daily_limit',
  'image_busy',
  'image_input',
  'usage_limit',
  'feature_limit',
]);
const CAPACITY_CODES = new Set(['rate_limited', 'daily_limit', 'free_limit', 'environment_limit', 'insufficient_credits', 'paid_blocked', 'image_daily_limit', 'image_busy']);

export interface ApiStreamError {
  code: string;
  message: string;
  retryable: boolean;
}

/** An engine error as the API reports it: no internal settings, variable names or provider details. */
export function safeStreamError(e: { code: string; message: string; retryable: boolean }): ApiStreamError {
  if (SAFE_ERROR_CODES.has(e.code) || e.code.startsWith('image_')) return { code: e.code, message: e.message, retryable: e.retryable };
  if (CAPACITY_CODES.has(e.code)) return { code: 'provider_capacity', message: 'The free AI capacity is used up for now. Please try again later.', retryable: true };
  return { code: 'provider_error', message: 'The AI provider could not complete this request. Please try again.', retryable: true };
}

export type ApiEvent =
  | { event: 'start'; data: { conversation_id: string; message_id: string; model: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'reasoning'; data: { text: string } }
  | { event: 'sources'; data: { sources: { index: number; title: string; url: string; site?: string }[] } }
  | { event: 'research'; data: { step: unknown } }
  | { event: 'notice'; data: { message: string } }
  | { event: 'image'; data: { id: string; mime: string; width: number; height: number; data_url: string } }
  | { event: 'usage'; data: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { event: 'error'; data: ApiStreamError }
  | { event: 'done'; data: { finish_reason: string | null; model: string; saved: boolean | null } };

/** Map one engine event to the API's public event (null = internal, not passed on). */
export function toApiEvent(e: StreamEvent, run: Pick<ChatRun, 'conversationId' | 'messageId' | 'includeReasoning'>): ApiEvent | null {
  switch (e.type) {
    case 'start':
      return { event: 'start', data: { conversation_id: run.conversationId, message_id: run.messageId, model: e.model } };
    case 'delta':
      return { event: 'delta', data: { text: e.text } };
    case 'reasoning':
      return run.includeReasoning ? { event: 'reasoning', data: { text: e.text } } : null;
    case 'sources':
      return {
        event: 'sources',
        data: { sources: e.sources.filter((s) => s.kind === 'web').map((s) => ({ index: s.index, title: s.title, url: s.url, ...(s.site ? { site: s.site } : {}) })) },
      };
    case 'research':
      return { event: 'research', data: { step: e.step } };
    case 'notice':
      return { event: 'notice', data: { message: e.message } };
    case 'image':
      return { event: 'image', data: { id: e.image.id, mime: e.image.mime, width: e.image.width, height: e.image.height, data_url: e.image.dataUrl } };
    case 'usage':
      return { event: 'usage', data: { prompt_tokens: e.usage.promptTokens, completion_tokens: e.usage.completionTokens, total_tokens: e.usage.totalTokens } };
    case 'error':
      return { event: 'error', data: safeStreamError(e) };
    case 'approval_required':
      return { event: 'error', data: { code: 'model_unavailable', message: 'This model is not available to applications. Use "auto" or another free model.', retryable: false } };
    case 'done':
      return { event: 'done', data: { finish_reason: e.finishReason, model: e.model, saved: null } };
    default:
      // allowance, route, context, search, image_progress, saved: internal
      return null;
  }
}

/** Parse the engine's SSE byte stream into events (yields as soon as each event is complete). */
export async function* engineEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            yield JSON.parse(line.slice(6)) as StreamEvent;
          } catch {
            /* not an event */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ChatResult {
  conversation_id: string;
  message_id: string;
  model: string | null;
  content: string;
  reasoning?: string;
  sources: { index: number; title: string; url: string; site?: string }[];
  images: { id: string; mime: string; width: number; height: number; data_url: string }[];
  notices: string[];
  finish_reason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  error: ApiStreamError | null;
}

/** Read a whole reply (non-streaming requests). */
export async function collectChat(run: ChatRun): Promise<ChatResult> {
  const out: ChatResult = {
    conversation_id: run.conversationId,
    message_id: run.messageId,
    model: null,
    content: '',
    sources: [],
    images: [],
    notices: [],
    finish_reason: null,
    usage: null,
    error: null,
  };
  let reasoning = '';
  if (!run.response.body) return out;
  for await (const e of engineEvents(run.response.body)) {
    const a = toApiEvent(e, run);
    if (!a) continue;
    if (a.event === 'start') out.model = a.data.model;
    else if (a.event === 'delta') out.content += a.data.text;
    else if (a.event === 'reasoning') reasoning += a.data.text;
    else if (a.event === 'sources') out.sources = a.data.sources;
    else if (a.event === 'notice') out.notices.push(a.data.message);
    else if (a.event === 'image') out.images.push(a.data);
    else if (a.event === 'usage') out.usage = a.data;
    else if (a.event === 'error') out.error = a.data;
    else if (a.event === 'done') {
      out.finish_reason = a.data.finish_reason;
      out.model = a.data.model;
    }
  }
  if (run.includeReasoning && reasoning) out.reasoning = reasoning;
  return out;
}

const encoder = new TextEncoder();
export const sseFrame = (e: ApiEvent) => encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);

/**
 * The API's own event stream: each engine event is translated and forwarded as soon as it arrives
 * (no buffering). `onEnd` runs once when the stream finishes or the client goes away.
 */
export function apiEventStream(run: ChatRun, head: Record<string, unknown>, onEnd: (r: { error: ApiStreamError | null }) => void): ReadableStream<Uint8Array> {
  const source = run.response.body;
  let ended = false;
  let lastError: ApiStreamError | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd({ error: lastError });
  };
  let iter: AsyncGenerator<StreamEvent> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify(head)}\n\n`));
      if (!source) {
        controller.close();
        end();
        return;
      }
      iter = engineEvents(source);
    },
    async pull(controller) {
      if (!iter) return;
      try {
        while (true) {
          const { done, value } = await iter.next();
          if (done) {
            controller.close();
            end();
            return;
          }
          const a = toApiEvent(value, run);
          if (!a) continue;
          if (a.event === 'error') lastError = a.data;
          controller.enqueue(sseFrame(a));
          return;
        }
      } catch {
        lastError = lastError ?? { code: 'provider_error', message: 'The reply stream was interrupted.', retryable: true };
        controller.enqueue(sseFrame({ event: 'error', data: lastError }));
        controller.close();
        end();
      }
    },
    async cancel() {
      // the client went away: generation continues on the server and the reply is stored
      end();
      await iter?.return(undefined);
    },
  });
}
