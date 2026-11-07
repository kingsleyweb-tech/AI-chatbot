import { waitUntil } from '@vercel/functions';
import { requireAllowedUser } from '../server/access.js';
import { chatRequestSchema, runChat } from '../server/chat/engine.js';
import { handle, HttpError, readJson } from '../server/http.js';
import type { ChatRequestBody } from '../server/shared/types.js';

export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const raw = await readJson<unknown>(request, 4_200_000);
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'bad_request', `Invalid request: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return runChat(ctx, parsed.data as ChatRequestBody, request.signal, (p) => waitUntil(p));
});
