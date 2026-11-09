import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { handleCentral, type CentralAction } from '../server/central/manage.js';
import { PERMISSIONS } from '../server/central/types.js';
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

/* ---- Atlas Central Knowledge (administrators only; roles are checked in handleCentral) ---- */
const kid = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const httpsUrl = z.string().max(2000).regex(/^https:\/\/\S+$/);
const tags = z.array(z.string().max(40)).max(10);
const central = z.discriminatedUnion('action', [
  z.object({ action: z.literal('kcRole') }),
  z.object({ action: z.literal('kcOverview') }),
  z.object({
    action: z.literal('kcList'),
    q: z.string().max(200).optional(),
    status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'ARCHIVED', 'ALL']).optional(),
    categoryId: z.string().max(40).nullish(),
    flag: z.string().max(40).nullish(),
    origin: z.string().max(20).nullish(),
    sort: z.enum(['updated', 'created', 'confidence', 'title']).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().min(1).max(1000).optional(),
    pageSize: z.number().int().min(5).max(100).optional(),
  }),
  z.object({ action: z.literal('kcGet'), id: kid }),
  z.object({ action: z.literal('kcSubmit'), title: z.string().max(400), content: z.string().max(8000), sources: z.array(httpsUrl).max(5), categoryId: kid.nullish(), tags: tags.optional() }),
  z.object({ action: z.literal('kcDiscoverUrl'), url: httpsUrl, categoryId: kid.nullish() }),
  z.object({
    action: z.literal('kcUpdate'),
    id: kid,
    title: z.string().max(400).optional(),
    content: z.string().max(8000).optional(),
    tags: tags.optional(),
    categoryId: kid.or(z.literal('')).nullish(),
    addSources: z.array(httpsUrl).max(5).optional(),
    removeSources: z.array(z.string().max(2000)).max(5).optional(),
  }),
  z.object({ action: z.literal('kcStatus'), id: kid, to: z.enum(['approve', 'reject', 'archive', 'restore']), reason: z.string().max(300).optional(), acknowledge: z.boolean().optional() }),
  z.object({ action: z.literal('kcDelete'), id: kid, confirm: z.literal(true) }),
  z.object({ action: z.literal('kcMerge'), targetId: kid, sourceId: kid }),
  z.object({ action: z.literal('kcReverify'), id: kid }),
  z.object({ action: z.literal('kcCategories') }),
  z.object({ action: z.literal('kcCategorySave'), id: kid.optional(), name: z.string().max(100), description: z.string().max(500).optional(), reviewDays: z.number().int().min(7).max(3650).nullish() }),
  z.object({ action: z.literal('kcCategoryDelete'), id: kid, moveTo: kid.nullish(), confirm: z.literal(true) }),
  z.object({ action: z.literal('kcCategoryMerge'), fromId: kid, intoId: kid }),
  z.object({ action: z.literal('kcAudit'), limit: z.number().int().min(1).max(500).optional(), recordId: kid.optional() }),
  z.object({ action: z.literal('kcIntelligence') }),
  z.object({ action: z.literal('kcSettings') }),
  z.object({
    action: z.literal('kcSettingsSave'),
    settings: z
      .object({
        admins: z.record(z.string().email().max(320), z.array(z.enum(PERMISSIONS as [string, ...string[]])).max(10)).optional(),
        reviewDays: z.number().int().min(7).max(3650).optional(),
        retrievalEnabled: z.boolean().optional(),
        discoveryFromWebSearch: z.boolean().optional(),
        discoveryDailyCap: z.number().int().min(0).max(100).optional(),
        topicInsights: z.boolean().optional(),
        assessmentsDailyCap: z.number().int().min(0).max(2000).optional(),
      })
      .strict(),
  }),
]);

/**
 * Knowledge base operations. Text from files is extracted in the browser (so
 * large files never hit the serverless body limit); this endpoint cleans,
 * chunks, embeds and indexes it, reads web pages, and deletes sources.
 */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const raw = await readJson(request, 4_400_000);
  if (raw && typeof raw === 'object' && typeof (raw as { action?: unknown }).action === 'string' && (raw as { action: string }).action.startsWith('kc')) {
    const c = central.safeParse(raw);
    if (!c.success) throw new HttpError(400, 'bad_request', 'Invalid knowledge management request.');
    return json(await handleCentral({ db: ctx.db, user: ctx.user, admin: ctx.admin }, c.data as CentralAction));
  }
  const parsed = schema.safeParse(raw);
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
