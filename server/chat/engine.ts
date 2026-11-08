import { z } from 'zod';
import type { Ctx } from '../access.js';
import { modelConfig } from '../config/models.js';
import { retrieveDocuments } from '../docs/documents.js';
import { retrieveKnowledge, type KnowledgeContext } from '../knowledge/retrieve.js';
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
import { detectTask } from '../router/task.js';
import { ProviderError } from '../providers/types.js';
import { gatherWebContext } from '../search/web.js';
import type {
  ApprovalRequest,
  ChatRequestBody,
  ModelInfo,
  ResearchStep,
  RouteInfo,
  SearchInfo,
  Source,
  StreamEvent,
  UsageInfo,
} from '../shared/types.js';
import { buildSystemPrompt, toProviderMessages, type UserSettings } from './prompt.js';

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
}

const APPROVAL_STOP = Symbol('approval_required');

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
  if (task.intent === 'imageGen' || task.intent === 'imageEdit') {
    notes.push(
      'Image generation and image editing are not available in this app. If the user asks you to create or edit an image, say so plainly. You may offer a detailed description, or a prompt they could use in an image tool. Never claim you produced or edited an image.',
    );
  }
  return notes;
}

/** In-flight replies on this server instance (idempotency guard). */
const activeRequests = new Set<string>();

export function friendlyError(err: unknown): Extract<StreamEvent, { type: 'error' }> {
  if (err instanceof ProviderError) {
    const suggestion =
      err.code === 'insufficient_credits'
        ? 'Choose a free model, or add credits to your OpenRouter account.'
        : err.code === 'daily_limit'
          ? 'Try again after the reset, or add OpenRouter credits (purchasing at least $10 raises the free-model limit). Atlas AI never buys credits for you.'
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
  signal: AbortSignal,
  background: BackgroundRunner,
): Promise<Response> {
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
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      void (async () => {
        let content = '';
        let reasoning = '';
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

          const models: ModelInfo[] = catalog?.models ?? [];
          const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
          const route = routeModel(body.model, task, models, {
            paidAvailable: catalog?.paidAvailable ?? null,
            approvedPaid: body.options.approvedPaidModel ?? null,
            preferredProvider: aiConfig.preferredProvider,
            fallback: aiConfig.fallback,
          });
          if (route.kind === 'none') {
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
          if (sources.length) send({ type: 'sources', sources });
          contextUsed = {
            memories: memories.length,
            documents: docs?.sources.length ?? 0,
            conversations: new Set([...related.map((r) => r.id), ...pastHits.map((h) => h.conversationId)]).size,
            knowledge: knowledge?.sources.length ?? 0,
            web: web?.sources.length ?? 0,
          };
          send({
            type: 'context',
            memories: memories.length,
            documents: docs?.sources.length ?? 0,
            conversations: new Set([...related.map((r) => r.id), ...pastHits.map((h) => h.conversationId)]).size,
            knowledge: knowledge?.sources.length ?? 0,
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
            webResults: web?.text || undefined,
            webSearchFailed: web?.failure ?? null,
            capabilityNotes: capabilityNotes(
              task,
              models.find((m) => m.id === chain[0]),
            ),
            deepResearch: Boolean(body.options.deepResearch && web?.text),
          });

          // ---- Generation with fallbacks ----
          let lastErr: unknown = null;
          for (let i = 0; i < chain.length; i++) {
            const modelId = chain[i];
            const info = models.find((m) => m.id === modelId);
            const { messages } = toProviderMessages(system, body.messages, {
              vision: info ? info.capabilities.vision : needsVision,
              budgetTokens: budget,
            });
            try {
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
              break;
            } catch (err) {
              if (signal.aborted) throw err;
              lastErr = err;
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
          if (lastErr) throw lastErr;
          if (!content.trim() && !signal.aborted) {
            throw new ProviderError('provider_error', 'The model returned an empty response.', 502);
          }
          send({ type: 'done', finishReason, model: usedModel });
        } catch (err) {
          if (err === APPROVAL_STOP) {
            // status and errorEvent were already set; nothing more to send
          } else if (signal.aborted) {
            status = 'stopped';
          } else {
            status = 'error';
            errorEvent = friendlyError(err);
            send(errorEvent);
          }
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }

        activeRequests.delete(requestKey);
        // ---- Persist the assistant message (even if the client disconnected) ----
        const msgPath = `${convPath}/messages/${body.assistantMessageId}`;
        const writes: Write[] = [
          {
            op: 'set',
            path: msgPath,
            data: {
              role: 'assistant',
              content,
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
              error: errorEvent
                ? {
                    code: errorEvent.code,
                    message: errorEvent.message,
                    suggestion: errorEvent.suggestion ?? null,
                  }
                : null,
              createdAt: SERVER_TIME,
            },
          },
          {
            op: 'increment',
            path: convPath,
            increments: { messageCount: 1 },
            data: { updatedAt: SERVER_TIME, lastModel: usedModel },
          },
        ];
        if (routeInfo) count(['routing', 'switched']);
        if (Object.keys(counters).length) {
          const day = new Date().toISOString().slice(0, 10);
          writes.push({ op: 'increment', path: `${base}/usage/${day}`, data: { date: day, updatedAt: SERVER_TIME }, increments: counters });
        }
        if (usage) {
          const day = new Date().toISOString().slice(0, 10);
          const modelKey = usedModel.replace(/[^A-Za-z0-9_]/g, '_');
          writes.push({
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
        try {
          await db.commit(writes);
        } catch (err) {
          console.error(
            '[chat] failed to persist assistant message',
            err instanceof Error ? err.message : err,
          );
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
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
