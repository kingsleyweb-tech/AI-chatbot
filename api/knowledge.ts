import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { addUrl, indexText, refresh, removeCollection, removeSource, search } from '../server/knowledge/service.js';

const id = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128);
const scope = z.enum(['personal', 'shared']).default('personal');

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('index'),
    scope,
    sourceId: id,
    sections: z.array(z.object({ ref: z.string().max(200), text: z.string() })).min(1).max(5000),
    warning: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal('addUrl'),
    scope,
    collectionId: id,
    url: z.string().url().max(2000),
    refreshDays: z.number().int().min(1).max(365).nullish(),
    viaTavily: z.boolean().optional(),
    addedFrom: z.enum(['manual', 'web_search']).optional(),
  }),
  z.object({ action: z.literal('refresh'), scope, sourceId: id, viaTavily: z.boolean().optional() }),
  z.object({ action: z.literal('deleteSource'), scope, sourceId: id }),
  z.object({ action: z.literal('deleteCollection'), scope, collectionId: id }),
  z.object({ action: z.literal('search'), query: z.string().min(1).max(2000) }),
]);

/**
 * Knowledge base operations. Text from files is extracted in the browser (so
 * large files never hit the serverless body limit); this endpoint cleans,
 * chunks, embeds and indexes it, reads web pages, and deletes sources.
 */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const parsed = schema.safeParse(await readJson(request, 4_400_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid knowledge base request.');
  const k = { db: ctx.db, uid: ctx.user.uid, admin: ctx.admin };
  const b = parsed.data;
  switch (b.action) {
    case 'index':
      return json({ ok: true, ...(await indexText(k, b)) });
    case 'addUrl':
      return json({ ok: true, ...(await addUrl(k, b)) });
    case 'refresh':
      return json({ ok: true, ...(await refresh(k, b)) });
    case 'deleteSource':
      return json({ ok: true, ...(await removeSource(k, b)) });
    case 'deleteCollection':
      return json({ ok: true, ...(await removeCollection(k, b)) });
    case 'search':
      return json({ ok: true, ...(await search(k, b)) });
  }
});
