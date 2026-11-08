/**
 * Project-aware memory.
 *
 * users/{uid}/projectMemory/{slug} keeps one structured brief per project the
 * user works on ("Project Alpha", "attendance platform"): description,
 * technologies, architecture, progress, decisions, known bugs, pending tasks
 * and the conversations it came from. Briefs are updated in the background
 * by a utility model after exchanges about that project.
 *
 * At answer time the project in focus is detected (named in the message,
 * semantically close to a brief, the chat's Atlas project, or the project the
 * chat was already about). Only that project's brief and memories are used;
 * memories tagged with other projects are left out so unrelated projects are
 * never mixed.
 */
import { embed } from '../embeddings.js';
import { SERVER_TIME, type Firestore } from '../firestore.js';
import { cosinePacked, packVector, terms, unpackVector } from '../knowledge/text.js';
import { parseJsonObject, utilityComplete } from '../utility.js';

export interface ProjectMemory {
  name: string;
  aliases: string[];
  linkedProjectId: string | null;
  description: string;
  technologies: string[];
  architecture: string;
  progress: string;
  decisions: string[];
  bugs: string[];
  tasks: string[];
  conversations: { id: string; title: string; at: number }[];
  /** packed embedding of name + description, for semantic focus detection */
  vector?: string | null;
  vectorModel?: string | null;
  origin: 'auto' | 'manual';
  updatedAt?: unknown;
}

export interface LoadedProject {
  slug: string;
  data: ProjectMemory;
}

export type Complete = typeof utilityComplete;
export type Embed = typeof embed;

const GENERIC = new Set(
  'project projects app apps application system platform website site tool tools service product my our the new version management manager'.split(' '),
);
const LIST_MAX = 12;
const CONV_MAX = 30;
/** cosine between a message and a project brief that counts as "about this project" */
export const PROJECT_SEM_MIN = 0.72;

/** Stable id from the distinctive words, so "Project Alpha" and "Alpha" share one brief. */
export function projectSlug(name: string): string {
  const words = distinctive(name).filter((w) => w.length > 0);
  const slug = (words.length ? words : ['project']).join('-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
  return `p_${slug || 'project'}`;
}

/** The distinctive words of a project name ("Project Alpha" -> alpha; "attendance platform" -> attendance). */
function distinctive(name: string): string[] {
  const t = terms(name);
  const d = t.filter((w) => !GENERIC.has(w));
  return d.length ? d : t;
}

/** Does the text name this project (or one of its aliases)? */
export function namesProject(text: string, p: Pick<ProjectMemory, 'name' | 'aliases'>): boolean {
  const q = new Set(terms(text));
  return [p.name, ...(p.aliases ?? [])].some((n) => {
    const d = distinctive(n);
    return d.length > 0 && d.length <= 6 && d.every((w) => q.has(w));
  });
}

export async function loadProjects(db: Firestore, uid: string): Promise<LoadedProject[]> {
  const docs = await db.list<ProjectMemory>(`users/${uid}/projectMemory`, { limit: 100 });
  return docs.map((d) => ({ slug: d.id, data: d.data }));
}

/**
 * Which project is this message about? Explicit mention wins, then the
 * chat's Atlas project, then semantic similarity, then the project the chat
 * was already about.
 */
export function detectFocus(args: {
  text: string;
  vector?: number[] | null;
  model?: string | null;
  projects: LoadedProject[];
  linkedProjectName?: string | null;
  conversationProject?: string | null;
}): { slug: string; name: string; reason: 'named' | 'linked' | 'similar' | 'conversation' } | null {
  const named = args.projects
    .filter((p) => namesProject(args.text, p.data))
    .sort((a, b) => distinctive(b.data.name).length - distinctive(a.data.name).length)[0];
  if (named) return { slug: named.slug, name: named.data.name, reason: 'named' };
  if (args.linkedProjectName) return { slug: projectSlug(args.linkedProjectName), name: args.linkedProjectName, reason: 'linked' };
  if (args.vector && args.model) {
    const q = Float32Array.from(args.vector);
    let best: { p: LoadedProject; s: number } | null = null;
    for (const p of args.projects) {
      if (!p.data.vector || p.data.vectorModel !== args.model) continue;
      const s = cosinePacked(unpackVector(p.data.vector), q);
      if (!best || s > best.s) best = { p, s };
    }
    if (best && best.s >= PROJECT_SEM_MIN) return { slug: best.p.slug, name: best.p.data.name, reason: 'similar' };
  }
  if (args.conversationProject) {
    const p = args.projects.find((x) => x.slug === args.conversationProject);
    if (p) return { slug: p.slug, name: p.data.name, reason: 'conversation' };
  }
  return null;
}

export function formatProject(p: ProjectMemory): string {
  const list = (title: string, items: string[]) => (items?.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '');
  return [
    p.description && `Description: ${p.description}`,
    p.technologies?.length ? `Technologies: ${p.technologies.join(', ')}` : '',
    p.architecture && `Architecture: ${p.architecture}`,
    p.progress && `Current progress: ${p.progress}`,
    list('Decisions', p.decisions),
    list('Known bugs / open problems', p.bugs),
    list('Pending tasks', p.tasks),
    p.conversations?.length ? `Discussed in: ${p.conversations.slice(-5).map((c) => `"${c.title}"`).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, max = LIST_MAX) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 240)))].slice(0, max) : [];

const UPDATE_PROMPT = `You maintain a structured brief about one of the user's projects, for an AI assistant's long-term memory.
Update the brief with what the latest exchange adds or changes. Keep it factual and concise; only include what the USER stated or confirmed.
- Replace outdated details (e.g. a changed technology or a new progress stage); drop bugs and tasks that were resolved or completed.
- Keep decisions with a short reason when given.
- Never include secrets (passwords, API keys, tokens) or unrelated personal details.
Respond with JSON only, all fields required:
{"description":"...","aliases":["other names the user uses for it"],"technologies":["..."],"architecture":"...","progress":"...","decisions":["..."],"bugs":["..."],"tasks":["..."]}`;

/** Update (or create) a project's brief from one exchange. */
export async function updateProjectMemory(args: {
  db: Firestore;
  uid: string;
  name: string;
  linkedProjectId?: string | null;
  conversationId: string;
  conversationTitle: string;
  userText: string;
  assistantText: string;
  now?: number;
  complete?: Complete;
  embedFn?: Embed;
}): Promise<string | null> {
  const name = args.name.trim().slice(0, 80);
  if (!name) return null;
  const slug = projectSlug(name);
  const path = `users/${args.uid}/projectMemory/${slug}`;
  const existing = (await args.db.get<ProjectMemory>(path))?.data;
  const current = {
    description: existing?.description ?? '',
    aliases: existing?.aliases ?? [],
    technologies: existing?.technologies ?? [],
    architecture: existing?.architecture ?? '',
    progress: existing?.progress ?? '',
    decisions: existing?.decisions ?? [],
    bugs: existing?.bugs ?? [],
    tasks: existing?.tasks ?? [],
  };
  const raw = await (args.complete ?? utilityComplete)(
    [
      { role: 'system', content: UPDATE_PROMPT },
      {
        role: 'user',
        content: `PROJECT: ${name}\nCURRENT BRIEF:\n${JSON.stringify(current)}\n\nLATEST EXCHANGE:\nUSER: ${args.userText.slice(0, 4000)}\n\nASSISTANT: ${args.assistantText.slice(0, 2500)}`,
      },
    ],
    { json: true, maxTokens: 900 },
  );
  const out = parseJsonObject<Record<string, unknown>>(raw);
  if (!out) return null;
  const now = args.now ?? Date.now();
  const next: ProjectMemory = {
    name: existing?.name ?? name,
    aliases: strList([...(current.aliases ?? []), ...strList(out.aliases)].filter((a) => a.toLowerCase() !== name.toLowerCase()), 6),
    linkedProjectId: args.linkedProjectId ?? existing?.linkedProjectId ?? null,
    description: str(out.description, 800) || current.description,
    technologies: strList(out.technologies),
    architecture: str(out.architecture, 800),
    progress: str(out.progress, 600),
    decisions: strList(out.decisions),
    bugs: strList(out.bugs),
    tasks: strList(out.tasks),
    conversations: [
      ...(existing?.conversations ?? []).filter((c) => c.id !== args.conversationId),
      { id: args.conversationId, title: args.conversationTitle.slice(0, 120), at: now },
    ].slice(-CONV_MAX),
    origin: existing?.origin ?? 'auto',
    vector: existing?.vector ?? null,
    vectorModel: existing?.vectorModel ?? null,
  };
  if (!existing || next.description !== existing.description) {
    const e = await (args.embedFn ?? embed)([`${next.name}\n${next.aliases.join(', ')}\n${next.description}`]).catch(() => null);
    if (e?.vectors[0]) {
      next.vector = packVector(e.vectors[0]);
      next.vectorModel = e.model;
    }
  }
  await args.db.set(path, { ...next, updatedAt: SERVER_TIME });
  return slug;
}

/**
 * Deletion policy for conversations: the conversation is removed from every
 * brief; a brief that drew on it is rebuilt from the summaries of the
 * conversations that remain, and an automatic brief with no conversations
 * left is deleted, so nothing from a deleted chat survives in project memory.
 */
export async function removeConversationFromProjects(args: { db: Firestore; uid: string; conversationId: string; complete?: Complete }): Promise<{ rebuilt: number; deleted: number }> {
  const projects = await loadProjects(args.db, args.uid);
  let rebuilt = 0;
  let deleted = 0;
  for (const p of projects) {
    if (!p.data.conversations?.some((c) => c.id === args.conversationId)) continue;
    const remaining = p.data.conversations.filter((c) => c.id !== args.conversationId);
    const path = `users/${args.uid}/projectMemory/${p.slug}`;
    if (!remaining.length && p.data.origin !== 'manual') {
      await args.db.delete(path);
      deleted++;
      continue;
    }
    const summaries = (
      await Promise.all(remaining.slice(-10).map((c) => args.db.get<{ summary?: string; historySummary?: string; title?: string }>(`users/${args.uid}/conversations/${c.id}`).catch(() => null)))
    )
      .filter((d) => d?.data.summary || d?.data.historySummary)
      .map((d) => `"${d!.data.title ?? ''}": ${d!.data.historySummary ?? d!.data.summary}`);
    const raw = summaries.length
      ? await (args.complete ?? utilityComplete)(
          [
            { role: 'system', content: UPDATE_PROMPT.replace('Update the brief with what the latest exchange adds or changes.', 'Rebuild the brief from scratch using ONLY these conversation summaries.') },
            { role: 'user', content: `PROJECT: ${p.data.name}\nCONVERSATION SUMMARIES:\n${summaries.join('\n')}` },
          ],
          { json: true, maxTokens: 900 },
        )
      : null;
    const out = parseJsonObject<Record<string, unknown>>(raw);
    await args.db.set(path, {
      ...p.data,
      conversations: remaining,
      description: out ? str(out.description, 800) : '',
      technologies: out ? strList(out.technologies) : [],
      architecture: out ? str(out.architecture, 800) : '',
      progress: out ? str(out.progress, 600) : '',
      decisions: out ? strList(out.decisions) : [],
      bugs: out ? strList(out.bugs) : [],
      tasks: out ? strList(out.tasks) : [],
      updatedAt: SERVER_TIME,
    });
    rebuilt++;
  }
  return { rebuilt, deleted };
}
