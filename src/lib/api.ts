import { auth } from './firebase';
import { parseSSE } from '@shared/sse';
import type { ChatRequestBody, StreamEvent } from '@shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** extra fields from the error body, e.g. retryAfter, attemptsLeft */
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function token(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
  return user.getIdToken();
}

/** Server codes meaning the account can no longer be used in this session. */
export const ACCOUNT_BLOCK_CODES = new Set(['account_suspended', 'account_deleted', 'session_revoked']);
export const ACCOUNT_BLOCK_EVENT = 'atlas:account-blocked';

async function toError(res: Response): Promise<ApiError> {
  let code = 'http_' + res.status;
  let message = res.statusText || 'Request failed.';
  let details: Record<string, unknown> = {};
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } & Record<string, unknown> };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    details = body.error ?? {};
  } catch {
    if (res.status === 404) message = 'The server API is not available. Is the backend running?';
  }
  // Let the auth state re-check the account (suspended, deleted or signed out everywhere).
  if (ACCOUNT_BLOCK_CODES.has(code)) window.dispatchEvent(new CustomEvent(ACCOUNT_BLOCK_EVENT, { detail: code }));
  return new ApiError(res.status, code, message, details);
}

/** Signed-out endpoints (password recovery). */
export async function publicApi<T>(path: string, json: unknown): Promise<T> {
  if (!navigator.onLine) throw new ApiError(0, 'offline', 'You are offline.');
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  if (!navigator.onLine) throw new ApiError(0, 'offline', 'You are offline.');
  const { json, ...rest } = init;
  const res = await fetch(`/api/${path}`, {
    ...rest,
    method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** POST /api/chat and yield normalized stream events. */
export async function* streamChat(body: ChatRequestBody, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  if (!navigator.onLine) throw new ApiError(0, 'offline', 'You are offline. Your message was saved; retry when connected.');
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await toError(res);
  for await (const data of parseSSE(res.body, signal)) {
    try {
      yield JSON.parse(data) as StreamEvent;
    } catch {
      /* ignore malformed event */
    }
  }
}
