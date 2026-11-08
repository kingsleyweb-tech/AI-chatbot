import type { StreamEvent } from './shared/types.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** extra machine-readable fields returned to the client (never secrets) */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...init.headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } }, { status: err.status });
  }
  console.error('[api] unexpected error:', err instanceof Error ? err.message : String(err));
  return json({ error: { code: 'internal', message: 'Unexpected server error.' } }, { status: 500 });
}

/** Raw request body (webhooks verify a signature over the exact bytes). */
export async function readText(request: Request, maxBytes = 100_000): Promise<string> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  return text;
}

export async function readJson<T>(request: Request, maxBytes = 4_000_000): Promise<T> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be valid JSON.');
  }
}

/** Wrap a handler so thrown HttpErrors become JSON responses. */
export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function sseEncode(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}
