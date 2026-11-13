import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { clearIndex } from '../server/memory/history.js';
import { deleteConversation } from '../server/memory/deleteConversation.js';
import { reembedMemory } from '../server/memory/memory.js';

const id = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reembed'), ids: z.array(id).min(1).max(50) }),
  z.object({ action: z.literal('deleteConversation'), conversationId: id }),
  z.object({ action: z.literal('deleteProject'), projectKey: id }),
  z.object({ action: z.literal('clearMemories'), includeProjects: z.boolean().optional() }),
  z.object({ action: z.literal('clearHistoryIndex') }),
]);

/** Memory maintenance for the signed-in user (always their own data, under the security rules). */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const parsed = schema.safeParse(await readJson(request, 100_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid memory request.');
  const { db, user } = ctx;
  const b = parsed.data;
  const base = `users/${user.uid}`;

  if (b.action === 'reembed') {
    const results = await Promise.all(b.ids.map((i) => reembedMemory(db, user.uid, i)));
    return json({ ok: true, embedded: results.filter(Boolean).length });
  }
  if (b.action === 'deleteConversation') {
    return json({ ok: true, deleted: await deleteConversation(db, user.uid, b.conversationId) });
  }
  if (b.action === 'deleteProject') {
    const mems = await db.list(`${base}/memories`, { where: [['project', 'EQUAL', b.projectKey]], limit: 500 });
    await db.commit([
      ...mems.flatMap((m) => [
        { op: 'delete' as const, path: `${base}/memories/${m.id}` },
        { op: 'delete' as const, path: `${base}/memoryVectors/${m.id}` },
      ]),
      { op: 'delete', path: `${base}/projectMemory/${b.projectKey}` },
    ]);
    return json({ ok: true, memories: mems.length });
  }
  if (b.action === 'clearHistoryIndex') {
    await clearIndex(db, user.uid);
    return json({ ok: true });
  }
  // clearMemories
  const [mems, vecs, projects] = await Promise.all([
    db.list(`${base}/memories`, { limit: 1000 }),
    db.list(`${base}/memoryVectors`, { limit: 1000 }),
    b.includeProjects ? db.list(`${base}/projectMemory`, { limit: 200 }) : Promise.resolve([]),
  ]);
  await db.commit([...mems, ...vecs, ...projects].map((d) => ({ op: 'delete' as const, path: d.path })));
  return json({ ok: true, memories: mems.length, projects: projects.length });
});
