import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import type { Firestore } from '../server/firestore.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { clearIndex, removeConversationFromIndex } from '../server/memory/history.js';
import { reembedMemory } from '../server/memory/memory.js';
import { removeConversationFromProjects } from '../server/memory/projects.js';

const id = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reembed'), ids: z.array(id).min(1).max(50) }),
  z.object({ action: z.literal('deleteConversation'), conversationId: id }),
  z.object({ action: z.literal('deleteProject'), projectKey: id }),
  z.object({ action: z.literal('clearMemories'), includeProjects: z.boolean().optional() }),
  z.object({ action: z.literal('clearHistoryIndex') }),
]);

/**
 * Deletion policy for a conversation: its messages, the conversation doc, its
 * summary vector and its history-index entries are deleted; automatic
 * memories extracted from it are deleted; project briefs that drew on it are
 * rebuilt from the remaining chats (or deleted when nothing remains).
 * Manually written memories and saved responses are kept.
 */
async function deleteConversation(db: Firestore, uid: string, conversationId: string) {
  const base = `users/${uid}`;
  const memories = await db.list<{ origin?: string }>(`${base}/memories`, {
    where: [['sourceConversationId', 'EQUAL', conversationId]],
    limit: 500,
  });
  const auto = memories.filter((m) => m.data.origin !== 'manual');
  await db.commit(auto.flatMap((m) => [
    { op: 'delete' as const, path: `${base}/memories/${m.id}` },
    { op: 'delete' as const, path: `${base}/memoryVectors/${m.id}` },
  ]));
  const indexEntries = await removeConversationFromIndex(db, uid, conversationId);
  await db.delete(`${base}/convVectors/${conversationId}`);
  // messages in pages (runs with the user's token, so only their own chat can be touched)
  const convPath = `${base}/conversations/${conversationId}`;
  for (let page = 0; page < 50; page++) {
    const msgs = await db.list(`${convPath}/messages`, { limit: 300 });
    if (!msgs.length) break;
    await db.commit(msgs.map((m) => ({ op: 'delete' as const, path: m.path })));
  }
  await db.delete(convPath);
  // after the conversation itself is gone, so rebuilt briefs can't draw on it
  const projects = await removeConversationFromProjects({ db, uid, conversationId });
  return { memories: auto.length, indexEntries, projects };
}

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
