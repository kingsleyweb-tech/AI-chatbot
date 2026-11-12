import { waitUntil } from '@vercel/functions';
import { requireAllowedUser } from '../server/access.js';
import { chatRequestSchema, runChat } from '../server/chat/engine.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import type { ChatRequestBody } from '../server/shared/types.js';
import { usageDb, usageSnapshot } from '../server/usage/allowance.js';

export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const raw = await readJson<unknown>(request, 4_200_000);
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'bad_request', `Invalid request: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return runChat(ctx, parsed.data as ChatRequestBody, request.signal, (p) => waitUntil(p));
});

/** GET /api/chat?usage: the signed-in user's AI allowances (usage indicator and Usage page). */
export const GET = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  if (!new URL(request.url).searchParams.has('usage')) throw new HttpError(404, 'not_found', 'Not found.');
  const db = (await usageDb()) ?? ctx.db;
  return json(await usageSnapshot(db, ctx.user.uid, ctx.admin), { headers: { 'cache-control': 'no-store' } });
});
