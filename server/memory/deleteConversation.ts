import type { Firestore } from '../firestore.js';
import { deleteImageWrites, type GeneratedImageMeta } from '../images/store.js';
import { removeConversationFromIndex } from './history.js';
import { removeConversationFromProjects } from './projects.js';

/**
 * Deletion policy for a conversation: its messages, the conversation doc, its
 * summary vector and its history-index entries are deleted; automatic
 * memories extracted from it are deleted; project briefs that drew on it are
 * rebuilt from the remaining chats (or deleted when nothing remains).
 * Pictures created in the conversation (metadata and image data) are deleted.
 * Manually written memories and saved responses are kept.
 */
export async function deleteConversation(db: Firestore, uid: string, conversationId: string) {
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
  // messages in pages (with the user's token on the website, so only their own chat can be touched)
  const convPath = `${base}/conversations/${conversationId}`;
  for (let page = 0; page < 50; page++) {
    const msgs = await db.list(`${convPath}/messages`, { limit: 300 });
    if (!msgs.length) break;
    await db.commit(msgs.map((m) => ({ op: 'delete' as const, path: m.path })));
  }
  await db.delete(convPath);
  const images = await deleteConversationImages(db, uid, conversationId);
  // after the conversation itself is gone, so rebuilt briefs can't draw on it
  const projects = await removeConversationFromProjects({ db, uid, conversationId });
  return { memories: auto.length, indexEntries, projects, images };
}

/** Delete every picture created in a conversation (the owner may delete their own images). */
export async function deleteConversationImages(db: Firestore, uid: string, conversationId: string): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < 20; page++) {
    const imgs = await db.list<GeneratedImageMeta>(`users/${uid}/generatedImages`, {
      where: [['conversationId', 'EQUAL', conversationId]],
      limit: 50,
    });
    if (!imgs.length) break;
    await db.commit(imgs.flatMap((i) => deleteImageWrites(uid, { id: i.id, chunks: i.data.chunks })));
    deleted += imgs.length;
    if (imgs.length < 50) break;
  }
  return deleted;
}
