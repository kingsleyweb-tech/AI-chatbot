import { z } from 'zod';
import type { Ctx } from '../access.js';
import { trustedDb } from '../admin.js';
import { modelConfig } from '../config/models.js';
import { retrieveDocuments } from '../docs/documents.js';
import { retrieveKnowledge, type KnowledgeContext } from '../knowledge/retrieve.js';
import { recordTopic, retrieveCentral, type CentralContext } from '../central/retrieve.js';
import { queueDiscovery } from '../central/manage.js';
import { isTrivial } from '../search/decide.js';
import { looksLikeFollowUp } from '../search/heuristics.js';
import { embed } from '../embeddings.js';
import { fieldPath, SERVER_TIME, type Write } from '../firestore.js';
import { HttpError, sseEncode, sseHeaders } from '../http.js';
import {
  extractAndStoreMemories,
  formatMemories,
  loadMemories,
  selectRelevant,
} from '../memory/memory.js';
import {
  generateTitle,
  relatedConversations,
  updateConversationSummary,
  updateHistorySummary,
} from '../memory/conversations.js';
import { formatHistory, indexExchange, loadIndex, searchHistory, tagConversationProject, type IndexEntry } from '../memory/history.js';
import { detectFocus, formatProject, loadProjects, projectSlug, updateProjectMemory, type LoadedProject } from '../memory/projects.js';
import { markFailed, markHealthy, preferHealthy } from '../providers/health.js';
import { getCatalog, providerFor } from '../providers/registry.js';
import { loadAiConfig } from '../config/ai.js';
import { routeModel, nextInChain } from '../router/route.js';
import { FREE_LIMIT_MESSAGE } from '../billing/policy.js';
import { detectTask } from '../router/task.js';
import { ProviderError } from '../providers/types.js';
import { gatherWebContext } from '../search/web.js';
import { cloudflareConfigured } from '../cloudflare/client.js';
import { reserveNeurons } from '../cloudflare/budget.js';
import { imageModel, editModel } from '../config/images.js';
import { detectImageIntent, IMAGE_REPLY_PREFIX } from '../images/intent.js';
import { ImageError, runImageTurn } from '../images/generate.js';
import type {
  ApprovalRequest,
  ChatRequestBody,
  GeneratedImageInfo,
  ModelInfo,
  ResearchStep,
  RouteInfo,
  SearchInfo,
  Source,
  StreamEvent,
  UsageInfo,
} from '../shared/types.js';
import { buildSystemPrompt, toProviderMessages, type UserSettings } from './prompt.js';
import { atlasIdentityBrief } from './identity.js';
import { isAboutAtlas } from '../shared/identity.js';

const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    name: z.string().max(300),
    mime: z.string().max(100),
    dataUrl: z
      .string()
      .max(1_500_000)
      .regex(/^data:image\/(png|jpe?g|webp|gif);base64,/),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    kind: z.literal('document'),
    documentId: z.string().max(128),
    name: z.string().max(300),
    mime: z.string().max(200),
  }),
]);

export const chatRequestSchema = z.object({
  conversationId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  assistantMessageId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  model: z.string().min(1).max(200),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(200_000),
        attachments: z.array(attachmentSchema).max(10).optional(),
      }),
    )
    .min(1)
    .max(80),
  options: z.object({
    webSearch: z.boolean(),
    autoSearch: z.boolean().optional(),
    searchMode: z.enum(['auto', 'manual', 'eager']).optional(),
    deepResearch: z.boolean().optional(),
    /** the message was spoken in Voice Mode and the reply will be read aloud */
    voice: z.boolean().optional(),
    memory: z.boolean(),
    approvedPaidModel: z.string().max(200).nullable().optional(),
    documentIds: z.array(z.string().max(128)).max(10),
    projectId: z.string().max(128).nullable().optional(),
  }),
});

export type BackgroundRunner = (p: Promise<unknown>) => void;

interface ConversationDoc {
  title?: string;
  titleSet?: boolean;
  projectId?: string | null;
  messageCount?: number;
  summaryAt?: string;
  /** projectMemory slug this chat is about */
  projectKey?: string | null;
  historySummary?: string;
  historySummaryCount?: number;
  /** the last picture created in this chat (for follow-up edits like "make it more realistic") */
  lastImage?: { id: string; messageId: string } | null;
}

const APPROVAL_STOP = Symbol('approval_required');
/** Failures that mean "this free model is used up for now" (Free Models Only policy). */
const LIMIT_CODES = new Set(['rate_limited', 'daily_limit', 'insufficient_credits', 'paid_blocked']);
/** the reply was an image (or an image refusal); no text model runs */
const IMAGE_DONE = Symbol('image_done');

/** Honest statements about what this model / app can and cannot do for this request. */
function capabilityNotes(
  task: ReturnType<typeof detectTask>,
  model: ModelInfo | undefined,
): string[] {
  const notes: string[] = [];
  if (model) {
    const inputs = [
      'text',
      model.capabilities.vision && 'images',
      model.capabilities.audioInput && 'audio',
    ]
      .filter(Boolean)
      .join(', ');
    notes.push(
      `You are running as ${model.name}, which accepts: ${inputs}. Never claim to see images, hear audio or read files that were not provided to you.`,
    );
  }
  if (cloudflareConfigured()) {
    notes.push(
      'Atlas AI creates and edits pictures with a separate image model when the user asks for one directly (for example "Generate an image of a lion in a forest", or, after a picture, "make it more realistic"). You, the text model, cannot create images yourself and never output image data or links. If the user seems to want a picture, suggest they ask directly, e.g. "Create an image of ...". Never claim you produced or edited an image in this reply.',
    );
  } else if (task.intent === 'imageGen' || task.intent === 'imageEdit') {
    notes.push(
      'Image generation and image editing are not available on this server right now. If the user asks you to create or edit an image, say so plainly. You may offer a detailed description, or a prompt they could use in an image tool. Never claim you produced or edited an image.',
    );
  }
  return notes;
}

/** In-flight replies on this server instance (idempotency guard). */
const activeRequests = new Set<string>();

export function friendlyError(err: unknown): Extract<StreamEvent, { type: 'error' }> {
  if (err instanceof ImageError) {
    return { type: 'error', code: err.code, message: err.message, retryable: err.retryable, suggestion: err.suggestion };
  }
  if (err instanceof ProviderError && err.code === 'daily_limit' && /cloudflare/i.test(err.message)) {
    return { type: 'error', code: err.code, message: err.message, retryable: false, suggestion: 'Try again after 00:00 UTC, or choose a Gemini or OpenRouter model. Atlas AI never switches to paid usage.' };
  }
  if (err instanceof ProviderError) {
    const suggestion =
      err.code === 'free_limit'
        ? 'Atlas AI uses free models only and never switches to paid usage.'
        : err.code === 'insufficient_credits' || err.code === 'paid_blocked'
          ? 'Choose another free model. Atlas AI uses free models only.'
          : err.code === 'daily_limit'
            ? 'Try again after the reset, or choose another free model. Atlas AI never switches to paid usage.'
          : err.code === 'rate_limited'
            ? 'Wait a moment and retry, or switch to another model.'
            : err.code === 'unsupported_input'
              ? 'Switch to a model that supports images.'
              : err.code === 'context_too_long'
                ? 'Start a new chat or choose a model with a larger context window.'
                : err.code === 'invalid_key'
                  ? 'Check the OPENROUTER_API_KEY server setting.'
                  : undefined;
    return {
      type: 'error',
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      suggestion,
    };
  }
  if (err instanceof HttpError)
    return { type: 'error', code: err.code, message: err.message, retryable: false };
  return {
    type: 'error',
    code: 'internal',
    message: 'Something went wrong while generating a response.',
    retryable: true,
  };
}

/**
 * Handle one chat turn: assemble context (memory, related conversations,
 * documents, web results), stream the model reply with fallbacks, persist
 * the assistant message, then run memory/title/summary jobs in background.
 */
export async function runChat(
  ctx: Ctx,
  body: ChatRequestBody,
  requestSignal: AbortSignal,
  background: BackgroundRunner,
): Promise<Response> {
  // Generation is NOT tied to the browser connection: on a phone, switching apps or locking the
  // screen drops the connection, and the reply must still be finished and stored. It stops only
  // when the user presses Stop (the browser marks the message with stopRequested, see watchAfterDisconnect).
  const gen = new AbortController();
  const signal = gen.signal;
  const { db, user } = ctx;
  const uid = user.uid;
  const base = `users/${uid}`;
  const convPath = `${base}/conversations/${body.conversationId}`;
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw new HttpError(400, 'bad_request', 'No user message to answer.');
  // Idempotency: a repeated request for the same reply (double submit, retry storm)
  // must not run the model or a search twice.
  const requestKey = `${uid}|${body.assistantMessageId}`;
  if (activeRequests.has(requestKey)) throw new HttpError(409, 'duplicate_request', 'This reply is already being generated.');

  // Load settings + conversation + catalog + attached document names in parallel.
  const [userDoc, convDoc, catalog, aiConfig, docMetas] = await Promise.all([
    db.get<{ settings?: UserSettings; displayName?: string }>(base),
    db.get<ConversationDoc>(convPath),
    getCatalog().catch(() => null),
    loadAiConfig(db),
    Promise.all(
      body.options.documentIds.map((id) =>
        db.get<{ name?: string; mime?: string }>(`${base}/documents/${id}`).catch(() => null),
      ),
    ),
  ]);
  const task = detectTask(
    body.messages,
    docMetas.filter((d) => d).map((d) => ({ name: d!.data.name ?? '', mime: d!.data.mime ?? '' })),
  );
  const needsVision = task.needsVision;
  // Image requests (Cloudflare Workers AI): detected without any model call.
  const lastAssistant = [...body.messages].reverse().find((m) => m.role === 'assistant');
  const attachedImage = lastUser.attachments?.find((a) => a.kind === 'image');
  const lastImage = convDoc?.data.lastImage ?? null;
  const imageIntent = cloudflareConfigured()
    ? detectImageIntent(lastUser.content, {
        hasImageAttachment: Boolean(attachedImage),
        previousImage: Boolean(lastImage?.id && lastAssistant && IMAGE_REPLY_PREFIX.test(lastAssistant.content)),
      })
    : null;
  const settings: UserSettings = {
    ...(userDoc?.data.settings ?? {}),
    displayName: userDoc?.data.displayName,
  };
  const memoryOn = body.options.memory && settings.memoryEnabled !== false;
  const projectId = body.options.projectId ?? convDoc?.data.projectId ?? null;
  /** turns in the conversation including this user message (the client sends at most the last 80) */
  const totalTurns = Math.max(convDoc?.data.messageCount ?? 0, body.messages.length);

  const encoder = new TextEncoder();
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send = (e: StreamEvent) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(sseEncode(e)));
    } catch {
      closed = true;
    }
  };

  activeRequests.add(requestKey);

  // The reply is stored as 'processing' straight away, so it exists in the
  // conversation even if this function is stopped before it finishes.
  // A retry reuses the failed reply's ID: that overwrites it (no duplicate)
  // and does not count it twice.
  const msgPath = `${convPath}/messages/${body.assistantMessageId}`;
  const placeholderDoc = { role: 'assistant', content: '', status: 'processing', model: body.model, error: null, createdAt: SERVER_TIME };
  const placeholder: Promise<boolean> = (async () => {
    try {
      await db.commit([
        { op: 'set', path: msgPath, data: placeholderDoc, precondition: { exists: false } },
        { op: 'increment', path: convPath, increments: { messageCount: 1 }, data: { updatedAt: SERVER_TIME } },
      ]);
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        return db.set(msgPath, placeholderDoc).then(() => true, () => false);
      }
      console.warn('[chat] could not create the reply placeholder', err instanceof Error ? err.message : err);
      return false;
    }
  })();

  // ---- After the browser disconnects: honour Stop, and store the text so far ----
  let finished = false;
  let progressText = () => '';
  let progress: Promise<unknown> = Promise.resolve();
  const watchAfterDisconnect = async () => {
    if (!(await placeholder)) return;
    let stored = -1;
    for (let i = 0; i < 40 && !finished && !signal.aborted; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 800 : 3000));
      if (finished) return;
      const doc = await db.get<{ stopRequested?: boolean }>(msgPath).catch(() => null);
      if (finished) return;
      if (doc?.data.stopRequested) {
        gen.abort();
        return;
      }
      const text = progressText();
      if (text.length !== stored) {
        stored = text.length;
        // shown to the user if they come back before the reply is finished
        progress = db.set(msgPath, { content: text }, true).catch(() => undefined);
        await progress;
      }
    }
  };
  const onDisconnect = () => {
    if (!finished) void watchAfterDisconnect();
  };
  if (requestSignal.aborted) onDisconnect();
  else requestSignal.addEventListener('abort', onDisconnect, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const job = (async () => {
        let content = '';
        let reasoning = '';
        progressText = () => content;
        let usage: UsageInfo | null = null;
        let usedModel = body.model;
        let status: 'complete' | 'stopped' | 'error' = 'complete';
        let errorEvent: Extract<StreamEvent, { type: 'error' }> | null = null;
        let finishReason: string | null = null;
        const sources: Source[] = [];
        const notices: string[] = [];
        let searchInfo: SearchInfo | null = null;
        let researchSteps: ResearchStep[] = [];
        let routeInfo: RouteInfo | null = null;
        let approval: ApprovalRequest | null = null;
        let contextUsed: { memories: number; documents: number; conversations: number; knowledge: number; web: number } | null = null;
        let focus: ReturnType<typeof detectFocus> = null;
        let knownProjects: LoadedProject[] = [];
        const images: GeneratedImageInfo[] = [];
        /** analytics counters for usage/{day} (codes only, never message text) */
        const counters: Record<string, number> = {};
        const count = (path: string[], n = 1) => {
          const k = fieldPath(...path);
          counters[k] = (counters[k] ?? 0) + n;
        };
        // Internal notes (model fallbacks, search provider switches) are kept on the
        // stored message for diagnostics, not shown in the chat.
        const notice = (message: string) => {
          notices.push(message);
        };

        try {
          // keep-alive comment so proxies flush headers immediately
          controller.enqueue(encoder.encode(': ok\n\n'));

          // ---- Image request: handled by the image model, not a chat model ----
          if (imageIntent) {
            const model = imageIntent.kind === 'edit' ? editModel() : imageModel();
            usedModel = model.id;
            send({ type: 'start', model: model.id });
            send({ type: 'image_progress', stage: 'checking' });
            try {
              const r = await runImageTurn({
                db,
                uid,
                conversationId: body.conversationId,
                messageId: body.assistantMessageId,
                intent: imageIntent,
                attachment: attachedImage && attachedImage.kind === 'image' ? attachedImage.dataUrl : null,
                previousImageId: lastImage?.id ?? null,
                signal,
                onStage: (stage) => send({ type: 'image_progress', stage }),
              });
              const info: GeneratedImageInfo = {
                id: r.meta.id,
                model: r.meta.model,
                mime: r.meta.mime,
                width: r.meta.width,
                height: r.meta.height,
                prompt: r.meta.prompt,
                kind: r.meta.kind,
                sourceImageId: r.meta.sourceImageId,
                stored: r.stored,
              };
              images.push(info);
              usedModel = r.meta.model;
              send({ type: 'image', image: { ...info, dataUrl: `data:${r.meta.mime};base64,${Buffer.from(r.bytes).toString('base64')}` } });
              const shown = r.meta.prompt.length > 300 ? `${r.meta.prompt.slice(0, 297)}…` : r.meta.prompt;
              content = `${r.meta.kind === 'edit' ? 'Edited the image' : 'Created an image'}: “${shown}”`;
              if (!r.stored) content += '\n\nThis image could not be saved to your account. Download it now to keep it.';
              count(['images', r.meta.kind === 'edit' ? 'edits' : 'generations']);
            } catch (err) {
              if (signal.aborted) throw err;
              if (err instanceof ImageError && !err.retryable) {
                // a refusal (safety rules, daily limits) is the answer itself, not a failure to retry
                content = err.suggestion ? `${err.message}\n\n${err.suggestion}` : err.message;
                count(['images', 'refused']);
              } else throw err;
            }
            send({ type: 'delta', text: content });
            finishReason = 'stop';
            send({ type: 'done', finishReason, model: usedModel });
            throw IMAGE_DONE;
          }

          const models: ModelInfo[] = catalog?.models ?? [];
          const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
          const route = routeModel(body.model, task, models, {
            paidAvailable: catalog?.paidAvailable ?? null,
            approvedPaid: body.options.approvedPaidModel ?? null,
            preferredProvider: aiConfig.preferredProvider,
            fallback: aiConfig.fallback,
          });
          if (route.kind === 'none') {
            // Every free model is at its limit (or none is offered): say so plainly.
            if (!models.some((m) => m.free && m.available)) throw new ProviderError('free_limit', FREE_LIMIT_MESSAGE, 429);
            throw new ProviderError(
              needsVision ? 'unsupported_input' : 'model_unavailable',
              route.reason,
              400,
            );
          }
          if (route.kind === 'approval') {
            // Never spend money without permission: stop here and ask.
            approval = {
              model: route.model.id,
              modelName: route.model.name,
              reason: route.reason,
              estCost: route.estCost,
              creditsNeeded: route.creditsNeeded,
            };
            send({ type: 'approval_required', approval });
            finishReason = 'approval_required';
            status = 'error';
            errorEvent = {
              type: 'error',
              code: 'approval_required',
              message: route.creditsNeeded
                ? `${route.reason} The OpenRouter account has no credits, so it cannot be used until credits are added.`
                : `${route.reason} Approve it to continue.`,
              retryable: false,
            };
            send({ type: 'done', finishReason, model: body.model });
            // Leave the try block without generating; the message is still persisted below.
            throw APPROVAL_STOP;
          }
          // models that just failed (quota, hang) go last so the user doesn't wait for them again
          const chain = preferHealthy(route.chain);
          if (route.switched) {
            routeInfo = {
              ...route.switched,
              fromName: nameOf(route.switched.from),
              toName: nameOf(route.switched.to),
            };
            send({ type: 'route', info: routeInfo });
          }

          // ---- Context assembly (in parallel) ----
          const queryText = lastUser.content.slice(0, 2000);
          const trivial = isTrivial(lastUser.content);
          // Independent reads start now, while the query is being embedded.
          const projectP = projectId
            ? db.get<{ name?: string; instructions?: string }>(`${base}/projects/${projectId}`).catch(() => null)
            : Promise.resolve(null);
          const projectsP = memoryOn ? loadProjects(db, uid).catch(() => [] as LoadedProject[]) : Promise.resolve([] as LoadedProject[]);
          const indexP = memoryOn ? loadIndex(db, uid).catch(() => [] as IndexEntry[]) : Promise.resolve([] as IndexEntry[]);
          const memoriesP = memoryOn ? loadMemories(db, uid).catch(() => []) : Promise.resolve([]);
          // A slow embedding service must not hold up the reply: after 3 s the
          // lexical fallbacks are used instead. Greetings need no embedding.
          const queryEmbedding =
            (memoryOn && !trivial) || body.options.documentIds.length
              ? await Promise.race([embed([queryText]).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3_000))])
              : null;
          const query = {
            text: queryText,
            vector: queryEmbedding?.vectors[0],
            model: queryEmbedding?.model,
          };
          const firstModel = models.find((m) => m.id === chain[0]);
          const contextWindow = firstModel?.contextLength || 32_000;
          const budget = Math.min(Math.floor(contextWindow * 0.6), 100_000);

          // Knowledge base first: it is cheap (a few index reads) and its result decides
          // whether a "do you know <company>" question still needs the web.
          // Greetings and arithmetic never touch any knowledge source.
          let knowledge: KnowledgeContext | null = null;
          // Atlas verified knowledge (platform-wide, VERIFIED records only) is read alongside; it may
          // never hold up the reply, so it gets 1.5 s and is dropped after that.
          const centralP: Promise<CentralContext | null> = trivial
            ? Promise.resolve(null)
            : Promise.race([
                retrieveCentral({ db, query, sourceOffset: 0 }).catch((err) => {
                  console.warn('[chat] central knowledge retrieval failed', err instanceof Error ? err.message : err);
                  return null;
                }),
                new Promise<null>((r) => setTimeout(() => r(null), 1_500)),
              ]);
          if (!trivial) {
            const previous = body.messages.filter((m) => m.role === 'user').slice(-2, -1)[0]?.content ?? '';
            // short follow-ups ("what services do they offer?") are searched with the previous question
            const kbText = previous && looksLikeFollowUp(lastUser.content) ? `${previous.slice(0, 600)}\n${queryText}` : queryText;
            knowledge = await retrieveKnowledge({
              db,
              uid,
              query: kbText === queryText ? query : { text: kbText },
              budgetTokens: Math.floor(budget * 0.35),
              sourceOffset: 0,
            }).catch((err) => {
              console.warn('[chat] knowledge retrieval failed', err instanceof Error ? err.message : err);
              return null;
            });
            if (knowledge) {
              count(['knowledge', 'retrievals']);
              if (knowledge.sources.length) count(['knowledge', 'used']);
              if (knowledge.hit) count(['knowledge', 'hits']);
            }
          }

          // ---- Project focus (decides which memories and past chats may be used) ----
          const [project, projects, historyIndex] = await Promise.all([projectP, projectsP, indexP]);
          focus = memoryOn
            ? detectFocus({
                text: queryText,
                vector: query.vector,
                model: query.model,
                projects,
                linkedProjectName: project?.data.name ?? null,
                conversationProject: convDoc?.data.projectKey ?? null,
              })
            : null;
          knownProjects = projects;
          const focusBrief = focus ? projects.find((p) => p.slug === focus!.slug) : undefined;
          // turns of this chat already in the context window are not retrieved again
          const sentFrom = totalTurns - body.messages.length;
          const pastHits = memoryOn
            ? await searchHistory({
                db,
                uid,
                query,
                focusProject: focus?.slug ?? null,
                entries: historyIndex,
                exclude: (e) => e.c === body.conversationId && e.k >= sentFrom,
              }).catch(() => [])
            : [];
          const convProject = new Map(historyIndex.map((e) => [e.c, e.p]));

          const [memories, related, docs, web] = await Promise.all([
            memoriesP.then((m) => (m.length ? selectRelevant(m, query, { focusProject: focus?.slug ?? null }) : [])).catch(() => []),
            memoryOn
              ? relatedConversations({ db, uid, excludeId: body.conversationId, query })
                  .then((r) =>
                    r.filter(
                      (c) =>
                        !pastHits.some((h) => h.conversationId === c.id) &&
                        // with a project in focus, other projects' chats stay out
                        (!focus || convProject.get(c.id) === focus.slug),
                    ),
                  )
                  .catch(() => [])
              : Promise.resolve([]),
            body.options.documentIds.length
              ? retrieveDocuments({
                  db,
                  uid,
                  documentIds: body.options.documentIds,
                  query,
                  budgetTokens: Math.floor(budget * 0.5),
                  sourceOffset: 0,
                }).catch((err) => {
                  console.warn(
                    '[chat] document retrieval failed',
                    err instanceof Error ? err.message : err,
                  );
                  return {
                    text: '',
                    sources: [] as Source[],
                    failed: ['attached documents (retrieval error)'],
                  };
                })
              : Promise.resolve(null),
            gatherWebContext({
              db,
              uid,
              turns: body.messages,
              text: lastUser.content,
              options: body.options,
              hasDocuments: body.options.documentIds.length > 0,
              knowledgeHit: Boolean(knowledge?.hit),
              signal,
              onStep: (step) => send({ type: 'research', step }),
              onDecision: (d) => {
                count(['searchDecisions', d.action]);
                count(['searchDecisions', 'reasons', d.reason]);
              },
            }).catch((err) => {
              if (signal.aborted) throw err;
              console.warn('[chat] web search failed', err instanceof Error ? err.message : err);
              return null;
            }),
          ]);

          if (web) {
            searchInfo = web.info;
            researchSteps = web.steps;
            sources.push(...web.sources);
            send({ type: 'search', info: web.info });
            for (const n of web.notices) notice(n);
            if (web.failure) notice(web.info.message ?? `Web search: ${web.failure}`);
          }
          if (docs?.sources.length) sources.push(...docs.sources);
          if (knowledge?.sources.length) sources.push(...knowledge.sources);
          // verified central records continue the [K n] numbering after the user's own knowledge
          const centralRaw = await centralP;
          const kOffset = knowledge?.sources.length ?? 0;
          const central = centralRaw
            ? {
                ...centralRaw,
                sources: centralRaw.sources.map((s) => ({ ...s, index: s.index + kOffset })),
                text: centralRaw.text.replace(/^\[K(\d+)\]/gm, (_m, d: string) => `[K${Number(d) + kOffset}]`),
              }
            : null;
          if (central?.sources.length) sources.push(...central.sources);
          if (!trivial) {
            // background, best effort: opt-in aggregated topics and source discovery (no conversation text kept)
            void recordTopic(db, queryText, Boolean(central)).catch(() => undefined);
            if (web?.sources.length) void queueDiscovery(db, web.sources.map((s) => s.url)).catch(() => undefined);
          }
          if (sources.length) send({ type: 'sources', sources });
          contextUsed = {
            memories: memories.length,
            documents: docs?.sources.length ?? 0,
            conversations: new Set([...related.map((r) => r.id), ...pastHits.map((h) => h.conversationId)]).size,
            knowledge: (knowledge?.sources.length ?? 0) + (central?.sources.length ?? 0),
            web: web?.sources.length ?? 0,
          };
          send({
            type: 'context',
            memories: memories.length,
            documents: docs?.sources.length ?? 0,
            conversations: new Set([...related.map((r) => r.id), ...pastHits.map((h) => h.conversationId)]).size,
            knowledge: (knowledge?.sources.length ?? 0) + (central?.sources.length ?? 0),
          });

          const system = buildSystemPrompt({
            settings,
            projectName: project?.data.name,
            projectInstructions: project?.data.instructions,
            memories: memories.length ? formatMemories(memories) : undefined,
            relatedConversations: related,
            pastExchanges: pastHits.length ? formatHistory(pastHits) : undefined,
            historySummary: convDoc?.data.historySummary || undefined,
            projectBrief: focus && focusBrief ? { name: focus.name, text: formatProject(focusBrief.data) } : null,
            documents: docs?.text || undefined,
            failedDocuments: docs?.failed,
            knowledge: knowledge?.text || undefined,
            centralKnowledge: central?.text || undefined,
            atlasIdentity: isAboutAtlas(queryText) ? atlasIdentityBrief() : undefined,
            webResults: web?.text || undefined,
            webSearchFailed: web?.failure ?? null,
            news: Boolean(web?.news),
            capabilityNotes: capabilityNotes(
              task,
              models.find((m) => m.id === chain[0]),
            ),
            deepResearch: Boolean(body.options.deepResearch && web?.text),
            voice: Boolean(body.options.voice),
          });

          // ---- Generation with fallbacks ----
          let lastErr: unknown = null;
          // stays true while every failure is a quota/limit one (then the free usage limit is reached)
          let onlyLimits = true;
          for (let i = 0; i < chain.length; i++) {
            const modelId = chain[i];
            const info = models.find((m) => m.id === modelId);
            const { messages } = toProviderMessages(system, body.messages, {
              vision: info ? info.capabilities.vision : needsVision,
              budgetTokens: budget,
            });
            const onCloudflare = providerFor(modelId).id === 'cloudflare';
            let cfReservation: Awaited<ReturnType<typeof reserveNeurons>> | null = null;
            try {
              if (onCloudflare) {
                // free daily allowance only: refuse (and fall back) rather than ever run into paid usage
                cfReservation = await reserveNeurons(db, 60);
                if (!cfReservation.ok) throw new ProviderError('daily_limit', 'Atlas AI has used today\u2019s free Cloudflare Workers AI allowance. It resets at 00:00 UTC.', 429);
              }
              send({ type: 'start', model: modelId });
              usedModel = modelId;
              for await (const chunk of providerFor(modelId).stream({
                model: modelId,
                messages,
                signal,
                maxTokens: modelConfig().maxOutputTokens,
                // with a fallback available, don't wait long for a stuck model
                ...(i < chain.length - 1 ? { firstByteTimeoutMs: 15_000 } : {}),
              })) {
                if (chunk.type === 'delta') {
                  content += chunk.text;
                  send({ type: 'delta', text: chunk.text });
                } else if (chunk.type === 'reasoning') {
                  reasoning += chunk.text;
                  send({ type: 'reasoning', text: chunk.text });
                } else if (chunk.type === 'usage') {
                  usage = chunk.usage;
                  send({ type: 'usage', usage: chunk.usage });
                } else if (chunk.type === 'finish') {
                  finishReason = chunk.reason;
                  usedModel = modelId;
                }
              }
              // Reasoning models can spend the whole budget thinking and return no
              // answer; treat that like any other recoverable failure and fall back.
              if (!content.trim() && !signal.aborted) {
                throw new ProviderError(
                  'provider_error',
                  finishReason === 'length'
                    ? 'The model used its whole output budget on reasoning without answering.'
                    : 'The model returned an empty response.',
                  502,
                );
              }
              lastErr = null;
              markHealthy(modelId);
              if (cfReservation?.ok) await cfReservation.settle(usage?.neurons ?? 0, { uid, model: modelId, type: 'text', ok: true });
              break;
            } catch (err) {
              if (cfReservation?.ok) {
                await cfReservation.settle(usage?.neurons ?? 0, { uid, model: modelId, type: 'text', ok: false, error: err instanceof ProviderError ? err.code : signal.aborted ? 'aborted' : 'internal' });
              }
              if (signal.aborted) throw err;
              lastErr = err;
              if (!(err instanceof ProviderError && LIMIT_CODES.has(err.code))) onlyLimits = false;
              if (err instanceof ProviderError && !content) markFailed(modelId, err.code);
              if (err instanceof ProviderError) {
                count(['providers', providerFor(modelId).id, 'failed']);
                if (err.code === 'rate_limited' || err.code === 'daily_limit') count(['providers', providerFor(modelId).id, 'rateLimited']);
              }
              if (!(err instanceof ProviderError) || content) break;
              const next = nextInChain(chain, i, err, (id) => providerFor(id).id);
              if (next === -1) break;
              count(['routing', 'fallbacks']);
              const switching = providerFor(chain[next]).id !== providerFor(modelId).id;
              if (switching) count(['routing', 'providerSwitches']);
              console.info(`[chat] fallback ${modelId} -> ${chain[next]} (${err.code})`);
              notice(`${nameOf(modelId)}: ${err.message} Used ${nameOf(chain[next])} instead.`);
              i = next - 1;
            }
          }
          if (lastErr && !content && onlyLimits) throw new ProviderError('free_limit', FREE_LIMIT_MESSAGE, 429);
          if (lastErr) throw lastErr;
          if (!content.trim() && !signal.aborted) {
            throw new ProviderError('provider_error', 'The model returned an empty response.', 502);
          }
          send({ type: 'done', finishReason, model: usedModel });
        } catch (err) {
          if (err === APPROVAL_STOP || err === IMAGE_DONE) {
            // status and errorEvent were already set; nothing more to send
          } else if (signal.aborted) {
            status = 'stopped';
          } else {
            status = 'error';
            errorEvent = friendlyError(err);
            send(errorEvent);
          }
        }

        activeRequests.delete(requestKey);
        finished = true;
        requestSignal.removeEventListener('abort', onDisconnect);
        // a progress write still on its way must not land after the final copy
        await progress;
        // ---- Persist the assistant message BEFORE the response ends ----
        // Work after the response has closed is not guaranteed to run on
        // Vercel (the function can be frozen), which lost replies before.
        // The whole job is also registered with waitUntil (below), so it
        // completes when the browser disconnects.
        const created = await placeholder;
        function lastImageField() {
          const img = images.find((i) => i.stored);
          return img ? { lastImage: { id: img.id, messageId: body.assistantMessageId } } : {};
        }
        const writes: Write[] = [
          {
            op: 'set',
            path: msgPath,
            merge: true,
            data: {
              role: 'assistant',
              content,
              stopRequested: null,
              reasoning: reasoning ? reasoning.slice(0, 20_000) : null,
              model: usedModel,
              status,
              sources,
              notices: notices.slice(0, 12),
              route: routeInfo,
              approval,
              search: searchInfo,
              contextUsed,
              researchSteps: researchSteps.slice(0, 20),
              usage,
              ...(images.length ? { images } : {}),
              error: errorEvent
                ? {
                    code: errorEvent.code,
                    message: errorEvent.message,
                    suggestion: errorEvent.suggestion ?? null,
                  }
                : null,
              // keep the placeholder's time, so the order matches when the message was sent
              ...(created ? {} : { createdAt: SERVER_TIME }),
            },
          },
          created
            ? // only if the chat still exists: a chat deleted while its reply was generating stays deleted
              { op: 'set', path: convPath, merge: true, data: { updatedAt: SERVER_TIME, lastModel: usedModel, ...lastImageField() }, precondition: { exists: true } }
            : {
                op: 'increment',
                path: convPath,
                increments: { messageCount: 1 },
                data: { updatedAt: SERVER_TIME, lastModel: usedModel, ...lastImageField() },
              },
        ];
        if (routeInfo) count(['routing', 'switched']);
        // Usage counters are server-written (read-only for users in the rules).
        const usageWrites: Write[] = [];
        if (Object.keys(counters).length) {
          const day = new Date().toISOString().slice(0, 10);
          usageWrites.push({ op: 'increment', path: `${base}/usage/${day}`, data: { date: day, updatedAt: SERVER_TIME }, increments: counters });
        }
        if (usage) {
          const day = new Date().toISOString().slice(0, 10);
          const modelKey = usedModel.replace(/[^A-Za-z0-9_]/g, '_');
          usageWrites.push({
            op: 'increment',
            path: `${base}/usage/${day}`,
            data: { date: day, updatedAt: SERVER_TIME },
            increments: {
              requests: 1,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              ...(usage.cost ? { cost: usage.cost } : {}),
              [fieldPath('models', modelKey, 'requests')]: 1,
              [fieldPath('models', modelKey, 'tokens')]: usage.totalTokens,
              [fieldPath('providers', providerFor(usedModel).id, 'requests')]: 1,
              [fieldPath('providers', providerFor(usedModel).id, 'tokens')]: usage.totalTokens,
            },
          });
        }
        let saved = false;
        for (let attempt = 0; attempt < 2 && !saved; attempt++) {
          try {
            await db.commit(writes);
            saved = true;
          } catch (err) {
            if ((err as { status?: number }).status === 409) {
              // the conversation was deleted meanwhile: nothing to store, and the browser must not store it either
              saved = true;
              break;
            }
            console.error(
              `[chat] failed to persist assistant message (attempt ${attempt + 1})`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        // tell the browser, which stores the reply itself if the server could not
        send({ type: 'saved', ok: saved });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        if (usageWrites.length) {
          try {
            await (await trustedDb(db)).commit(usageWrites);
          } catch (err) {
            console.warn('[chat] usage write failed', err instanceof Error ? err.message : err);
          }
        }

        // ---- Background jobs: title, memory, summary ----
        if (status === 'complete' && content) {
          background(
            (async () => {
              const conv = convDoc?.data ?? {};
              let title = conv.title ?? 'New chat';
              if (!conv.titleSet) {
                const t = await generateTitle(lastUser.content, content).catch(() => null);
                if (t) {
                  title = t;
                  await db.set(convPath, { title: t, titleSet: true }, true).catch(() => undefined);
                }
              }
              const warn = (what: string) => (err: unknown) => console.warn(`[${what}] failed`, err instanceof Error ? err.message : err);
              const total = totalTurns + 1;
              const jobs: Promise<unknown>[] = [
                // conversation context, not long-term memory: runs even with memory off
                updateHistorySummary({
                  db,
                  uid,
                  conversationId: body.conversationId,
                  state: conv,
                  total,
                }).catch(warn('history-summary')),
              ];
              if (memoryOn) {
                jobs.push(
                  (async () => {
                    const extracted = await extractAndStoreMemories({
                      db,
                      uid,
                      conversationId: body.conversationId,
                      conversationTitle: title,
                      userText: lastUser.content,
                      assistantText: content,
                      knownProjects: knownProjects.map((p) => p.data.name),
                      slugFor: projectSlug,
                    }).catch((err) => {
                      warn('memory')(err);
                      return null;
                    });
                    // the project this exchange is about: named by the extractor, else the focus / chat's project
                    const projectName = extracted?.project ?? focus?.name ?? null;
                    const slug = projectName ? projectSlug(projectName) : (conv.projectKey ?? null);
                    const tasks: Promise<unknown>[] = [
                      indexExchange({
                        db,
                        uid,
                        conversationId: body.conversationId,
                        position: total - 2,
                        title,
                        project: slug,
                        userText: lastUser.content,
                        assistantText: content,
                      }).catch(warn('history-index')),
                    ];
                    if (projectName) {
                      tasks.push(
                        updateProjectMemory({
                          db,
                          uid,
                          name: projectName,
                          linkedProjectId: focus?.reason === 'linked' ? projectId : null,
                          conversationId: body.conversationId,
                          conversationTitle: title,
                          userText: lastUser.content,
                          assistantText: content,
                        }).catch(warn('project-memory')),
                      );
                      if (slug && slug !== conv.projectKey) {
                        tasks.push(db.set(convPath, { projectKey: slug }, true).catch(warn('project-key')));
                        tasks.push(tagConversationProject(db, uid, body.conversationId, slug).catch(warn('project-tag')));
                      }
                    }
                    await Promise.all(tasks);
                  })(),
                );
                const count = total;
                if (count === 2 || count % 6 === 0) {
                  jobs.push(
                    updateConversationSummary({
                      db,
                      uid,
                      conversationId: body.conversationId,
                      title,
                      messages: [...body.messages, { role: 'assistant', content }],
                    }).catch((err) =>
                      console.warn('[summary] failed', err instanceof Error ? err.message : err),
                    ),
                  );
                }
              }
              await Promise.all(jobs);
            })(),
          );
        }
      })();
      // keep the function alive until the reply is stored, even if the browser disconnects
      background(
        job.catch((err) => {
          console.error('[chat] reply job failed', err instanceof Error ? err.message : err);
          finished = true;
          activeRequests.delete(requestKey);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }),
      );
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
