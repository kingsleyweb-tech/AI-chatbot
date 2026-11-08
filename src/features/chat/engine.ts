import { useSyncExternalStore } from 'react';
import type { ApprovalRequest, ChatRequestBody, ChatTurn, ResearchStep, RouteInfo, SearchInfo, Source, StreamEvent } from '@shared/types';
import { ApiError, streamChat } from '@/lib/api';
import { saveAssistantFallback } from '@/lib/db';
import type { Message } from '@/lib/types';
import { newId } from '@/lib/utils';

export interface LiveReply {
  id: string;
  conversationId: string;
  content: string;
  reasoning: string;
  sources: Source[];
  model: string;
  notices: string[];
  search?: SearchInfo;
  researchSteps: ResearchStep[];
  route?: RouteInfo;
  approval?: ApprovalRequest;
  status: 'connecting' | 'streaming' | 'done' | 'stopped' | 'error';
  /** true once the server confirmed the reply is stored in Firestore */
  saved?: boolean;
  error?: { code: string; message: string; suggestion?: string; retryable: boolean };
  context?: { memories: number; documents: number; conversations: number; knowledge: number };
  startedAt: number;
}

/*
 * Tiny external store so replies survive route changes. Every reply of a
 * conversation is kept (oldest first) until its stored copy arrives from
 * Firestore: starting a new reply must never hide an earlier one.
 */
const replies = new Map<string, LiveReply[]>();
const MAX_KEPT = 20;
const aborts = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let scheduled = false;
let version = 0;

function emit(immediate = false) {
  if (immediate) {
    version++;
    listeners.forEach((l) => l());
    return;
  }
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    version++;
    listeners.forEach((l) => l());
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const active = (r: LiveReply) => r.status === 'streaming' || r.status === 'connecting';
const EMPTY: LiveReply[] = [];

/** All replies of a conversation not yet confirmed by Firestore, oldest first. */
export function useLiveReplies(conversationId: string | undefined): LiveReply[] {
  useSyncExternalStore(subscribe, () => version);
  return (conversationId && replies.get(conversationId)) || EMPTY;
}

export function useAnyStreaming(): Set<string> {
  useSyncExternalStore(subscribe, () => version);
  return new Set([...replies.values()].flat().filter(active).map((r) => r.conversationId));
}

/**
 * Conversations with a user message on its way to Firestore (written locally, not yet
 * confirmed). Kept here, not in component state, because sending a first message switches
 * to the new conversation's page while the write is still pending.
 */
const sending = new Set<string>();
export function setSending(conversationId: string, on: boolean) {
  if (on === sending.has(conversationId)) return;
  if (on) sending.add(conversationId);
  else sending.delete(conversationId);
  emit(true);
}
export function useSending(conversationId: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version);
  return Boolean(conversationId && sending.has(conversationId));
}

/** Forget a finished reply (its stored copy is shown instead). Never removes one still generating. */
export function clearLiveReply(conversationId: string, replyId: string) {
  const list = replies.get(conversationId);
  if (!list) return;
  const next = list.filter((r) => r.id !== replyId || active(r));
  if (next.length === list.length) return;
  if (next.length) replies.set(conversationId, next);
  else replies.delete(conversationId);
  emit(true);
}

export function stopGeneration(conversationId: string) {
  aborts.get(conversationId)?.abort();
}

export function isGenerating(conversationId: string): boolean {
  return aborts.has(conversationId);
}

/** Build the provider history from stored messages (oldest first). */
export function toTurns(messages: Message[], max = 40): ChatTurn[] {
  return messages
    .filter((m) => m.content?.trim() || m.attachments?.length)
    .filter((m) => !(m.role === 'assistant' && (m.status === 'error' || m.status === 'processing') && !m.content))
    .slice(-max)
    .map((m) => ({
      role: m.role,
      content: m.content ?? '',
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    }));
}

export async function generate(args: {
  uid: string;
  conversationId: string;
  model: string;
  history: ChatTurn[];
  options: ChatRequestBody['options'];
  /** reuse a failed reply's ID on retry, so it is replaced instead of duplicated */
  replyId?: string;
}): Promise<void> {
  const { uid, conversationId } = args;
  aborts.get(conversationId)?.abort();
  const controller = new AbortController();
  aborts.set(conversationId, controller);
  const reply: LiveReply = {
    id: args.replyId ?? newId(),
    conversationId,
    content: '',
    reasoning: '',
    sources: [],
    model: args.model,
    notices: [],
    researchSteps: [],
    status: 'connecting',
    startedAt: Date.now(),
  };
  const kept = (replies.get(conversationId) ?? []).filter((r) => r.id !== reply.id);
  replies.set(conversationId, [...kept, reply].slice(-MAX_KEPT));
  emit(true);

  const apply = (e: StreamEvent) => {
    switch (e.type) {
      case 'start':
        reply.model = e.model;
        reply.status = 'streaming';
        break;
      case 'notice':
        reply.notices = [...reply.notices, e.message];
        if (e.model) reply.model = e.model;
        break;
      case 'sources':
        reply.sources = e.sources;
        break;
      case 'search':
        reply.search = e.info;
        break;
      case 'route':
        reply.route = e.info;
        break;
      case 'approval_required':
        reply.approval = e.approval;
        break;
      case 'research':
        reply.researchSteps = [...reply.researchSteps, e.step];
        break;
      case 'context':
        reply.context = { memories: e.memories, documents: e.documents, conversations: e.conversations, knowledge: e.knowledge ?? 0 };
        break;
      case 'reasoning':
        reply.reasoning += e.text;
        break;
      case 'delta':
        reply.status = 'streaming';
        reply.content += e.text;
        break;
      case 'error':
        reply.status = 'error';
        reply.error = { code: e.code, message: e.message, suggestion: e.suggestion, retryable: e.retryable };
        break;
      case 'done':
        reply.status = 'done';
        reply.model = e.model;
        break;
      case 'saved':
        reply.saved = e.ok;
        break;
    }
  };

  try {
    for await (const event of streamChat(
      {
        conversationId,
        assistantMessageId: reply.id,
        model: args.model,
        messages: args.history,
        options: args.options,
      },
      controller.signal,
    )) {
      apply(event);
      emit();
    }
    if (reply.status === 'streaming' || reply.status === 'connecting') {
      // stream ended without a terminal event (connection dropped): keep what arrived, marked as interrupted
      reply.status = reply.content ? 'stopped' : 'error';
      if (!reply.content) reply.error = { code: 'network', message: 'The connection was interrupted.', retryable: true };
    }
  } catch (err) {
    if (controller.signal.aborted) {
      reply.status = 'stopped';
    } else {
      reply.status = 'error';
      if (err instanceof ApiError && err.code === 'duplicate_request') {
        // an earlier attempt reached the server and is still running: its stored reply will appear
        reply.saved = true;
        reply.error = { code: err.code, message: 'This reply is still being generated. It will appear here when it is ready.', retryable: false };
      } else reply.error =
        err instanceof ApiError
          ? { code: err.code, message: err.message, retryable: err.status >= 500 || err.status === 0 }
          : { code: 'network', message: 'Could not reach the server. Check your connection and retry.', retryable: true };
    }
  } finally {
    if (aborts.get(conversationId) === controller) aborts.delete(conversationId);
    emit(true);
  }
  // The server stores every reply before it ends the response. If it could
  // not (or the connection broke first), store what this browser received;
  // Firestore queues the write and retries it while offline.
  if (!reply.saved && !reply.approval) {
    const backup = () =>
      saveAssistantFallback(uid, conversationId, reply.id, {
        content: reply.content,
        model: reply.model,
        sources: reply.sources,
        reasoning: reply.reasoning || null,
        status: reply.status === 'done' ? 'complete' : reply.status === 'stopped' ? 'stopped' : 'error',
        error: reply.status === 'error' && reply.error ? { code: reply.error.code, message: reply.error.message, suggestion: reply.error.suggestion ?? null } : null,
      });
    try {
      await backup();
    } catch (err) {
      // offline: try again once the connection is back
      if (navigator.onLine) console.warn('[chat] could not store the reply', err);
      else {
        await new Promise<void>((resolve) => window.addEventListener('online', () => resolve(), { once: true }));
        await backup().catch((e) => console.warn('[chat] could not store the reply', e));
      }
    }
  }
}
