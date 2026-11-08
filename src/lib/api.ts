import { auth } from './firebase';
import { initMonitoring, report, SLOW_API_MS, type ClientReport } from './monitor';
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
export const ACCOUNT_BLOCK_CODES = new Set(['account_suspended', 'account_deleted', 'session_revoked', 'consent_required']);
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
  const started = performance.now();
  const action = json && typeof json === 'object' && 'action' in json ? `/${String((json as { action: unknown }).action)}` : '';
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      ...rest,
      method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError' && !(err instanceof ApiError)) report({ kind: 'api', message: 'network error', path: path + action });
    throw err;
  }
  const ms = Math.round(performance.now() - started);
  if (res.status >= 500) report({ kind: 'api', message: `HTTP ${res.status}`, path: path + action, status: res.status, ms });
  else if (ms > SLOW_API_MS) report({ kind: 'slow', message: 'slow response', path: path + action, status: res.status, ms });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Send one monitoring report straight to the server (never through api(), so it cannot report itself). */
async function sendReport(r: ClientReport): Promise<void> {
  const user = auth.currentUser;
  if (!user || !navigator.onLine) return;
  await fetch('/api/account', {
    method: 'POST',
    keepalive: true,
    headers: { authorization: `Bearer ${await user.getIdToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'clientReport', ...r }),
  });
}

/** Start client monitoring (uncaught errors, failed and slow API calls). Called once at startup. */
export function startMonitoring() {
  initMonitoring(sendReport);
}

/** POST /api/chat and yield normalized stream events. */
export async function* streamChat(body: ChatRequestBody, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  if (!navigator.onLine) throw new ApiError(0, 'offline', 'You are offline. Your message was saved; retry when connected.');
  const post = async () =>
    fetch('/api/chat', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  let res: Response;
  try {
    res = await post();
  } catch (err) {
    // The request did not get through (dropped connection): try once more. Safe, because the
    // reply ID is the same and the server refuses a second run of a reply it is still generating.
    if (signal.aborted || !(err instanceof TypeError)) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    if (signal.aborted) throw err;
    res = await post();
  }
  if (!res.ok || !res.body) throw await toError(res);
  for await (const data of parseSSE(res.body, signal)) {
    try {
      yield JSON.parse(data) as StreamEvent;
    } catch {
      /* ignore malformed event */
    }
  }
}
