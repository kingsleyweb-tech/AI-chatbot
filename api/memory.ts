import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { reembedMemory } from '../server/memory/memory.js';

const schema = z.object({
  action: z.literal('reembed'),
  ids: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/).max(128)).min(1).max(50),
});

/** Recompute embeddings after the user edits or adds memories manually. */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const parsed = schema.safeParse(await readJson(request, 100_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid memory request.');
  const results = await Promise.all(parsed.data.ids.map((id) => reembedMemory(ctx.db, ctx.user.uid, id)));
  return json({ ok: true, embedded: results.filter(Boolean).length });
});
