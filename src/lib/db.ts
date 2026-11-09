import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { api, ApiError } from './api';
import { db } from './firebase';
import type { Attachment, Conversation, Memory, Message, Project, UserSettings } from './types';
import { newId } from './utils';

export const paths = {
  user: (uid: string) => doc(db, 'users', uid),
  conversations: (uid: string) => collection(db, 'users', uid, 'conversations'),
  conversation: (uid: string, cid: string) => doc(db, 'users', uid, 'conversations', cid),
  messages: (uid: string, cid: string) => collection(db, 'users', uid, 'conversations', cid, 'messages'),
  message: (uid: string, cid: string, mid: string) => doc(db, 'users', uid, 'conversations', cid, 'messages', mid),
  memories: (uid: string) => collection(db, 'users', uid, 'memories'),
  memory: (uid: string, id: string) => doc(db, 'users', uid, 'memories', id),
  memoryVector: (uid: string, id: string) => doc(db, 'users', uid, 'memoryVectors', id),
  projects: (uid: string) => collection(db, 'users', uid, 'projects'),
  project: (uid: string, id: string) => doc(db, 'users', uid, 'projects', id),
  documents: (uid: string) => collection(db, 'users', uid, 'documents'),
  document: (uid: string, id: string) => doc(db, 'users', uid, 'documents', id),
  chunks: (uid: string, id: string) => collection(db, 'users', uid, 'documents', id, 'chunks'),
  saved: (uid: string) => collection(db, 'users', uid, 'savedResponses'),
  savedItem: (uid: string, id: string) => doc(db, 'users', uid, 'savedResponses', id),
  usage: (uid: string) => collection(db, 'users', uid, 'usage'),
  convVector: (uid: string, cid: string) => doc(db, 'users', uid, 'convVectors', cid),
  projectMemory: (uid: string) => collection(db, 'users', uid, 'projectMemory'),
  securityEvents: (uid: string) => collection(db, 'users', uid, 'securityEvents'),
};

export function fromSnap<T>(snap: QueryDocumentSnapshot<DocumentData>): T {
  return { id: snap.id, ...snap.data({ serverTimestamps: 'estimate' }) } as T;
}

// ---------- settings ----------
export async function saveSettings(uid: string, patch: Partial<UserSettings>) {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) data[`settings.${k}`] = v;
  await updateDoc(paths.user(uid), data);
}

// ---------- conversations ----------
export async function createConversation(
  uid: string,
  init: { id?: string; title: string; projectId: string | null; model: string | null; documentIds: string[] },
): Promise<string> {
  const id = init.id ?? newId();
  await setDoc(paths.conversation(uid, id), {
    title: init.title.slice(0, 80) || 'New chat',
    titleSet: false,
    projectId: init.projectId,
    saved: false,
    model: init.model,
    documentIds: init.documentIds,
    messageCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return id;
}

export async function updateConversation(uid: string, cid: string, patch: Partial<Omit<Conversation, 'id'>>) {
  await updateDoc(paths.conversation(uid, cid), patch as DocumentData);
}

export async function renameConversation(uid: string, cid: string, title: string) {
  await updateDoc(paths.conversation(uid, cid), { title: title.slice(0, 120), titleSet: true });
}

export async function attachDocument(uid: string, cid: string, documentId: string, attach: boolean) {
  await updateDoc(paths.conversation(uid, cid), {
    documentIds: attach ? arrayUnion(documentId) : arrayRemove(documentId),
  });
}

/**
 * Delete a conversation with the server-side policy: messages, summary,
 * history-index entries, automatic memories taken from it and project-memory
 * references. Falls back to deleting the chat itself when the server cannot
 * be reached (the server cleans the rest up on the next delete).
 */
export async function deleteConversation(uid: string, cid: string) {
  try {
    await api('memory', { json: { action: 'deleteConversation', conversationId: cid } });
    return;
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 0 && err.status < 500)) throw err;
  }
  await deleteConversationLocal(uid, cid);
}

/** Delete a conversation and all of its messages directly (offline fallback). */
async function deleteConversationLocal(uid: string, cid: string) {
  // pictures created in this chat go with it (metadata and image data)
  await import('@/features/images/images').then((m) => m.deleteConversationImagesLocal(uid, cid)).catch((err) => console.warn('[db] could not delete chat images', err));
  while (true) {
    const snap = await getDocs(query(paths.messages(uid, cid), limit(400)));
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 400) break;
  }
  const batch = writeBatch(db);
  batch.delete(paths.conversation(uid, cid));
  batch.delete(paths.convVector(uid, cid));
  await batch.commit();
}

// ---------- messages ----------
export async function addUserMessage(
  uid: string,
  cid: string,
  content: string,
  attachments: Attachment[],
  id: string = newId(),
): Promise<string> {
  const batch = writeBatch(db);
  batch.set(paths.message(uid, cid, id), {
    role: 'user',
    content,
    attachments,
    status: 'complete',
    createdAt: serverTimestamp(),
  });
  batch.update(paths.conversation(uid, cid), { updatedAt: serverTimestamp(), messageCount: increment(1) });
  await batch.commit();
  return id;
}

/**
 * Store a reply from the browser when the server could not (connection lost,
 * server write failed, stopped). Merges into the server's 'processing' copy,
 * so nothing else in the conversation is touched.
 */
export async function saveAssistantFallback(
  uid: string,
  cid: string,
  id: string,
  data: Pick<Message, 'content' | 'model' | 'sources' | 'reasoning' | 'images'> & {
    status: 'complete' | 'stopped' | 'error';
    error: Message['error'];
  },
) {
  const ref = paths.message(uid, cid, id);
  const conv = paths.conversation(uid, cid);
  // A transaction (not a blind write), so this backup can never overwrite a reply the server has
  // already stored, nor bring back a conversation that was deleted meanwhile.
  return runTransaction(db, async (tx) => {
    const c = await tx.get(conv);
    const m = await tx.get(ref);
    if (!c.exists()) return 'skipped' as const;
    const stored = m.exists() ? (m.data().status as string | undefined) : undefined;
    if (stored && stored !== 'processing') return 'skipped' as const;
    tx.set(ref, m.exists() ? { role: 'assistant', ...data } : { role: 'assistant', createdAt: serverTimestamp(), ...data }, { merge: true });
    return 'saved' as const;
  });
}

/**
 * Ask the server to stop a reply. Needed because the server keeps generating when the connection
 * drops (a phone switching apps): only an explicit Stop ends it. Fails quietly if the reply does not exist yet.
 */
export async function requestStop(uid: string, cid: string, id: string) {
  await updateDoc(paths.message(uid, cid, id), { stopRequested: true });
}

/** Status of a stored reply, read from the server (not the local cache); null if it does not exist. */
export async function storedReplyStatus(uid: string, cid: string, id: string): Promise<string | null> {
  const snap = await getDocFromServer(paths.message(uid, cid, id));
  return snap.exists() ? ((snap.data().status as string | undefined) ?? null) : null;
}

export async function editUserMessage(uid: string, cid: string, mid: string, content: string) {
  await updateDoc(paths.message(uid, cid, mid), { content, editedAt: serverTimestamp() });
}

export async function deleteMessages(uid: string, cid: string, ids: string[]) {
  if (!ids.length) return;
  const batch = writeBatch(db);
  ids.forEach((id) => batch.delete(paths.message(uid, cid, id)));
  batch.update(paths.conversation(uid, cid), { messageCount: increment(-ids.length) });
  await batch.commit();
}

// ---------- saved responses ----------
export async function toggleSavedResponse(
  uid: string,
  conv: Pick<Conversation, 'id' | 'title'>,
  message: Message,
  saved: boolean,
) {
  const ref = paths.savedItem(uid, message.id);
  if (!saved) return deleteDoc(ref);
  await setDoc(ref, {
    conversationId: conv.id,
    conversationTitle: conv.title,
    messageId: message.id,
    content: message.content,
    model: message.model ?? null,
    createdAt: serverTimestamp(),
  });
}

// ---------- projects ----------
export async function saveProject(uid: string, p: Partial<Project> & { name: string }) {
  const id = p.id ?? newId();
  await setDoc(
    paths.project(uid, id),
    {
      name: p.name.slice(0, 80),
      instructions: (p.instructions ?? '').slice(0, 8000),
      updatedAt: serverTimestamp(),
      ...(p.id ? {} : { createdAt: serverTimestamp() }),
    },
    { merge: true },
  );
  return id;
}

export async function deleteProject(uid: string, id: string) {
  // detach conversations; keep them
  const snap = await getDocs(query(paths.conversations(uid), orderBy('updatedAt', 'desc'), limit(1000)));
  const batch = writeBatch(db);
  snap.docs.filter((d) => d.data().projectId === id).forEach((d) => batch.update(d.ref, { projectId: null }));
  batch.delete(paths.project(uid, id));
  await batch.commit();
}

// ---------- memories ----------
export async function saveMemory(uid: string, m: Partial<Memory> & { text: string }): Promise<string> {
  const id = m.id ?? newId();
  await setDoc(
    paths.memory(uid, id),
    {
      text: m.text.slice(0, 500),
      category: m.category ?? 'fact',
      reason: m.reason ?? 'Added manually.',
      active: m.active ?? true,
      ...(m.importance !== undefined ? { importance: Math.min(5, Math.max(1, Math.round(m.importance))) } : {}),
      ...(m.project !== undefined ? { project: m.project } : {}),
      updatedAt: serverTimestamp(),
      ...(m.id ? {} : { origin: 'manual', createdAt: serverTimestamp(), sourceConversationId: null }),
    },
    { merge: true },
  );
  return id;
}

export async function deleteMemory(uid: string, id: string) {
  const batch = writeBatch(db);
  batch.delete(paths.memory(uid, id));
  batch.delete(paths.memoryVector(uid, id));
  await batch.commit();
}

export async function deleteAllMemories(uid: string) {
  for (const col of [paths.memories(uid), collection(db, 'users', uid, 'memoryVectors')]) {
    while (true) {
      const snap = await getDocs(query(col, limit(400)));
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

// ---------- documents ----------
export async function deleteDocument(uid: string, id: string) {
  while (true) {
    const snap = await getDocs(query(paths.chunks(uid, id), limit(400)));
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(paths.document(uid, id));
}
