import { cosine, embed, rank } from '../embeddings.js';
import { Firestore, SERVER_TIME, type Write } from '../firestore.js';
import { MEMORY_CATEGORIES, type MemoryCategory } from '../shared/types.js';
import { parseJsonObject, utilityComplete } from '../utility.js';

export interface MemoryDoc {
  text: string;
  category: MemoryCategory;
  reason: string;
  active: boolean;
  origin: 'auto' | 'manual';
  sourceConversationId?: string | null;
  sourceTitle?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemoryVector {
  embedding: number[];
  model: string;
}

export interface LoadedMemory {
  id: string;
  data: MemoryDoc;
  vector?: MemoryVector;
}

/** Above this similarity two memories are treated as the same fact. */
export const DUPLICATE_THRESHOLD = 0.9;
/** With this few memories, all of them are sent instead of retrieving. */
const SEND_ALL_BELOW = 25;

export async function loadMemories(db: Firestore, uid: string): Promise<LoadedMemory[]> {
  const [mems, vecs] = await Promise.all([
    db.list<MemoryDoc>(`users/${uid}/memories`, { limit: 500 }),
    db.list<MemoryVector>(`users/${uid}/memoryVectors`, { limit: 500 }),
  ]);
  const vmap = new Map(vecs.map((v) => [v.id, v.data]));
  return mems
    .filter((m) => m.data.active !== false && m.data.text)
    .map((m) => ({ id: m.id, data: m.data, vector: vmap.get(m.id) }));
}

export function selectRelevant(
  memories: LoadedMemory[],
  query: { text: string; vector?: number[] | null; model?: string | null },
  limit = 12,
): LoadedMemory[] {
  if (memories.length <= SEND_ALL_BELOW) return memories;
  const ranked = rank(memories, query, (m) => ({
    text: m.data.text,
    vector: m.vector?.embedding,
    model: m.vector?.model,
  }));
  // Instructions and preferences are always useful; keep a few regardless of score.
  const always = memories.filter((m) => m.data.category === 'instruction').slice(0, 5);
  const relevant = ranked.filter((r) => r.score > 0.3).map((r) => r.item);
  const out = [...always];
  for (const m of relevant) if (!out.includes(m) && out.length < limit) out.push(m);
  return out;
}

export function formatMemories(memories: LoadedMemory[]): string {
  return memories.map((m) => `- [${m.data.category}] ${m.data.text}`).join('\n');
}

interface MemoryOp {
  op: 'add' | 'update' | 'delete';
  id?: string;
  text?: string;
  category?: string;
  reason?: string;
}

const EXTRACT_PROMPT = `You manage the long-term memory of a personal AI assistant.
Decide whether the latest exchange contains information worth remembering for FUTURE conversations.

Remember only durable, useful information the USER voluntarily shared or asked you to remember:
preferences, personal context, ongoing projects, technical preferences, decisions, standing instructions, recurring topics.
Do NOT remember: one-off questions, the assistant's own statements, temporary details, secrets (passwords, keys, card or ID numbers),
or sensitive health/financial details unless the user explicitly asks you to remember them.
If the user corrects a memory, UPDATE it. If the user asks you to forget something, DELETE the matching memory.
Never duplicate an existing memory; update it instead.
Write each memory as one short third-person sentence, e.g. "Prefers concise answers with code examples."

Respond with JSON only:
{"operations":[{"op":"add","text":"...","category":"preference|personal|project|technical|instruction|decision|fact|topic","reason":"why this is worth remembering"},
{"op":"update","id":"<existing id>","text":"...","reason":"..."},
{"op":"delete","id":"<existing id>","reason":"..."}]}
Return {"operations":[]} when nothing should change.`;

/**
 * Memory pipeline step run after each assistant reply: extract candidate
 * facts, dedupe/resolve conflicts against existing memories, persist.
 */
export async function extractAndStoreMemories(args: {
  db: Firestore;
  uid: string;
  conversationId: string;
  conversationTitle?: string | null;
  userText: string;
  assistantText: string;
}): Promise<{ added: number; updated: number; deleted: number }> {
  const { db, uid } = args;
  const result = { added: 0, updated: 0, deleted: 0 };
  if (args.userText.trim().length < 8) return result;

  const existing = await loadMemories(db, uid);
  const exchange = `USER: ${args.userText.slice(0, 4000)}\n\nASSISTANT: ${args.assistantText.slice(0, 2000)}`;
  const queryEmbedding = await embed([args.userText.slice(0, 2000)]);
  const related = rank(
    existing,
    { text: args.userText, vector: queryEmbedding?.vectors[0], model: queryEmbedding?.model },
    (m) => ({ text: m.data.text, vector: m.vector?.embedding, model: m.vector?.model }),
  )
    .slice(0, 20)
    .map((r) => r.item);

  const raw = await utilityComplete(
    [
      { role: 'system', content: EXTRACT_PROMPT },
      {
        role: 'user',
        content: `EXISTING MEMORIES:\n${related.map((m) => `${m.id}: ${m.data.text}`).join('\n') || '(none)'}\n\nLATEST EXCHANGE:\n${exchange}`,
      },
    ],
    { json: true, maxTokens: 700 },
  );
  const parsed = parseJsonObject<{ operations?: MemoryOp[] }>(raw);
  const ops = (parsed?.operations ?? []).slice(0, 6);
  if (!ops.length) return result;

  const validIds = new Set(existing.map((m) => m.id));
  const toEmbed = ops.filter((o) => (o.op === 'add' || o.op === 'update') && o.text?.trim());
  const embedded = await embed(toEmbed.map((o) => o.text!.trim()));
  const writes: Write[] = [];

  for (const op of ops) {
    const text = op.text?.trim().slice(0, 500);
    const reason = (op.reason ?? '').slice(0, 300) || 'Mentioned in conversation.';
    const category = (MEMORY_CATEGORIES as readonly string[]).includes(op.category ?? '')
      ? (op.category as MemoryCategory)
      : 'fact';
    if (op.op === 'delete' && op.id && validIds.has(op.id)) {
      writes.push({ op: 'delete', path: `users/${uid}/memories/${op.id}` });
      writes.push({ op: 'delete', path: `users/${uid}/memoryVectors/${op.id}` });
      result.deleted++;
      continue;
    }
    if (!text) continue;
    const vec = embedded ? embedded.vectors[toEmbed.indexOf(op)] : undefined;
    let targetId = op.op === 'update' && op.id && validIds.has(op.id) ? op.id : null;

    if (!targetId && vec && embedded) {
      // dedupe: if a near-identical memory exists, update it instead of adding
      const dup = existing.find(
        (m) => m.vector?.model === embedded.model && cosine(m.vector.embedding, vec) >= DUPLICATE_THRESHOLD,
      );
      if (dup) targetId = dup.id;
    }
    if (!targetId) {
      const lower = text.toLowerCase();
      const dup = existing.find((m) => m.data.text.toLowerCase() === lower);
      if (dup) continue;
    }

    const id = targetId ?? crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const base = {
      text,
      reason,
      active: true,
      updatedAt: SERVER_TIME,
      sourceConversationId: args.conversationId,
      sourceTitle: args.conversationTitle ?? null,
    };
    if (targetId) {
      writes.push({ op: 'set', path: `users/${uid}/memories/${id}`, data: base, merge: true });
      result.updated++;
    } else {
      writes.push({
        op: 'set',
        path: `users/${uid}/memories/${id}`,
        data: { ...base, category, origin: 'auto', createdAt: SERVER_TIME },
      });
      result.added++;
    }
    if (vec && embedded) {
      writes.push({
        op: 'set',
        path: `users/${uid}/memoryVectors/${id}`,
        data: { embedding: vec, model: embedded.model },
      });
    }
  }
  await db.commit(writes);
  return result;
}

/** (Re)compute the embedding for a single memory after a manual edit. */
export async function reembedMemory(db: Firestore, uid: string, id: string): Promise<boolean> {
  const mem = await db.get<MemoryDoc>(`users/${uid}/memories/${id}`);
  if (!mem) {
    await db.delete(`users/${uid}/memoryVectors/${id}`);
    return false;
  }
  const e = await embed([mem.data.text]);
  if (!e) return false;
  await db.set(`users/${uid}/memoryVectors/${id}`, { embedding: e.vectors[0], model: e.model });
  return true;
}
