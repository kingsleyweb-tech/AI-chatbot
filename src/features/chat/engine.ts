import { useSyncExternalStore } from 'react';
import type { ApprovalRequest, ChatRequestBody, ChatTurn, ResearchStep, RouteInfo, SearchInfo, Source, StreamEvent } from '@shared/types';
import { ApiError, streamChat } from '@/lib/api';
import { savePartialAssistant } from '@/lib/db';
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
  error?: { code: string; message: string; suggestion?: string; retryable: boolean };
  context?: { memories: number; documents: number; conversations: number };
  startedAt: number;
}

/* ---- tiny external store so replies survive route changes ---- */
const replies = new Map<string, LiveReply>();
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

export function useLiveReply(conversationId: string | undefined): LiveReply | undefined {
  useSyncExternalStore(subscribe, () => version);
  return conversationId ? replies.get(conversationId) : undefined;
}

export function useAnyStreaming(): Set<string> {
  useSyncExternalStore(subscribe, () => version);
  return new Set([...replies.values()].filter((r) => r.status === 'streaming' || r.status === 'connecting').map((r) => r.conversationId));
}

export function clearLiveReply(conversationId: string) {
  const r = replies.get(conversationId);
  if (r && (r.status === 'streaming' || r.status === 'connecting')) return;
  if (replies.delete(conversationId)) emit(true);
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
    .filter((m) => !(m.role === 'assistant' && m.status === 'error' && !m.content))
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
}): Promise<void> {
  const { uid, conversationId } = args;
  aborts.get(conversationId)?.abort();
  const controller = new AbortController();
  aborts.set(conversationId, controller);
  const reply: LiveReply = {
    id: newId(),
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
  replies.set(conversationId, reply);
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
        reply.context = { memories: e.memories, documents: e.documents, conversations: e.conversations };
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
      // stream ended without a terminal event (connection dropped)
      reply.status = reply.content ? 'done' : 'error';
      if (!reply.content) reply.error = { code: 'network', message: 'The connection was interrupted.', retryable: true };
    }
  } catch (err) {
    if (controller.signal.aborted) {
      reply.status = 'stopped';
      if (reply.content) {
        await savePartialAssistant(uid, conversationId, reply.id, {
          content: reply.content,
          model: reply.model,
          sources: reply.sources,
          reasoning: reply.reasoning || null,
        }).catch(() => undefined);
      }
    } else {
      reply.status = 'error';
      reply.error =
        err instanceof ApiError
          ? { code: err.code, message: err.message, retryable: err.status >= 500 || err.status === 0 }
          : { code: 'network', message: 'Could not reach the server. Check your connection and retry.', retryable: true };
    }
  } finally {
    if (aborts.get(conversationId) === controller) aborts.delete(conversationId);
    emit(true);
  }
}
