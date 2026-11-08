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
  /** 1 (minor) .. 5 (essential); missing = 3 */
  importance?: number;
  /** projectMemory slug when the memory is about one project, else null (applies everywhere) */
  project?: string | null;
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
  opts: { focusProject?: string | null; limit?: number } = {},
): LoadedMemory[] {
  const limit = opts.limit ?? 12;
  const focus = opts.focusProject ?? null;
  // never mix projects: memories tagged with another project are left out
  const pool = memories.filter((m) => !m.data.project || m.data.project === focus);
  const general = (m: LoadedMemory) => !m.data.project;
  const ranked = rank(pool, query, (m) => ({
    text: m.data.text,
    vector: m.vector?.embedding,
    model: m.vector?.model,
  }));
  const scored = new Map(ranked.map((r) => [r.item, r.score]));
  const byScore = (a: LoadedMemory, b: LoadedMemory) => (scored.get(b) ?? 0) - (scored.get(a) ?? 0) || importanceOf(b) - importanceOf(a);
  // standing instructions and important preferences apply to every message
  const always = pool
    .filter((m) => general(m) && (m.data.category === 'instruction' || m.data.category === 'preference') && importanceOf(m) >= 3)
    .sort((a, b) => importanceOf(b) - importanceOf(a))
    .slice(0, 6);
  // the focused project's own memories are always relevant to it
  const projectOwn = focus ? pool.filter((m) => m.data.project === focus).sort(byScore).slice(0, 6) : [];
  const out = [...always];
  for (const m of projectOwn) if (!out.includes(m)) out.push(m);
  if (pool.length <= SEND_ALL_BELOW) {
    for (const m of [...pool].sort(byScore)) if (!out.includes(m)) out.push(m);
    return out;
  }
  // more important memories need a slightly lower relevance score
  const threshold = (m: LoadedMemory) => 0.3 - (importanceOf(m) - 3) * 0.03;
  for (const r of ranked) {
    if (out.length >= limit) break;
    if (!out.includes(r.item) && r.score > threshold(r.item)) out.push(r.item);
  }
  return out;
}

export const importanceOf = (m: LoadedMemory) => Math.min(5, Math.max(1, Math.round(m.data.importance ?? 3)));

export function formatMemories(memories: LoadedMemory[]): string {
  return memories.map((m) => `- [${m.data.category}${importanceOf(m) >= 4 ? ', important' : ''}] ${m.data.text}`).join('\n');
}

interface MemoryOp {
  op: 'add' | 'update' | 'delete';
  id?: string;
  text?: string;
  category?: string;
  reason?: string;
  importance?: number;
  /** true when the memory only applies to the exchange's project */
  projectSpecific?: boolean;
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

Rate each memory's importance 1-5 (5 = standing instruction or core fact the assistant should always know; 1 = minor detail).
If the exchange is about a specific named project the user works on (an app, product, research or business project), give its name in "project"
(reuse the exact name from KNOWN PROJECTS when it is the same project), else null. Mark a memory "projectSpecific": true when it only applies
to that project (e.g. its tech stack or a decision about it); general preferences are false.

Respond with JSON only:
{"project":null,"operations":[{"op":"add","text":"...","category":"preference|personal|project|technical|instruction|decision|fact|topic","importance":3,"projectSpecific":false,"reason":"why this is worth remembering"},
{"op":"update","id":"<existing id>","text":"...","importance":3,"reason":"..."},
{"op":"delete","id":"<existing id>","reason":"..."}]}
Return {"project":null,"operations":[]} when nothing should change.`;

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
  /** names of the user's known projects, so the extractor reuses them */
  knownProjects?: string[];
  /** maps a project name to its projectMemory slug */
  slugFor?: (name: string) => string;
  complete?: typeof utilityComplete;
  embedFn?: typeof embed;
}): Promise<{ added: number; updated: number; deleted: number; project: string | null }> {
  const { db, uid } = args;
  const embedder = args.embedFn ?? embed;
  const result = { added: 0, updated: 0, deleted: 0, project: null as string | null };
  if (args.userText.trim().length < 8) return result;

  const existing = await loadMemories(db, uid);
  const exchange = `USER: ${args.userText.slice(0, 4000)}\n\nASSISTANT: ${args.assistantText.slice(0, 2000)}`;
  const queryEmbedding = await embedder([args.userText.slice(0, 2000)]);
  const related = rank(
    existing,
    { text: args.userText, vector: queryEmbedding?.vectors[0], model: queryEmbedding?.model },
    (m) => ({ text: m.data.text, vector: m.vector?.embedding, model: m.vector?.model }),
  )
    .slice(0, 20)
    .map((r) => r.item);

  const raw = await (args.complete ?? utilityComplete)(
    [
      { role: 'system', content: EXTRACT_PROMPT },
      {
        role: 'user',
        content:
          `KNOWN PROJECTS: ${(args.knownProjects ?? []).join('; ') || '(none)'}\n\n` +
          `EXISTING MEMORIES:\n${related.map((m) => `${m.id}: ${m.data.text}`).join('\n') || '(none)'}\n\nLATEST EXCHANGE:\n${exchange}`,
      },
    ],
    { json: true, maxTokens: 800 },
  );
  const parsed = parseJsonObject<{ project?: unknown; operations?: MemoryOp[] }>(raw);
  const rawProject = typeof parsed?.project === 'string' ? parsed.project.trim() : '';
  result.project = rawProject && rawProject.toLowerCase() !== 'null' ? rawProject.slice(0, 80) : null;
  const projectSlug = result.project && args.slugFor ? args.slugFor(result.project) : null;
  const ops = (Array.isArray(parsed?.operations) ? parsed.operations : []).slice(0, 6);
  if (!ops.length) return result;

  const validIds = new Set(existing.map((m) => m.id));
  const toEmbed = ops.filter((o) => (o.op === 'add' || o.op === 'update') && o.text?.trim());
  const embedded = await embedder(toEmbed.map((o) => o.text!.trim()));
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
    const importance = typeof op.importance === 'number' && Number.isFinite(op.importance) ? Math.min(5, Math.max(1, Math.round(op.importance))) : 3;
    const scope =
      op.op === 'add' || typeof op.projectSpecific === 'boolean' ? { project: op.projectSpecific && projectSlug ? projectSlug : null } : {};
    const base = {
      text,
      reason,
      importance,
      ...scope,
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
