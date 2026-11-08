import { beforeEach, describe, expect, it } from 'vitest';
import { updateHistorySummary, VERBATIM_TURNS } from '../server/memory/conversations.js';
import { indexExchange, loadIndex, removeConversationFromIndex, searchHistory, SHARD_MAX, tagConversationProject } from '../server/memory/history.js';
import { selectRelevant, type LoadedMemory } from '../server/memory/memory.js';
import { detectFocus, loadProjects, namesProject, projectSlug, removeConversationFromProjects, updateProjectMemory } from '../server/memory/projects.js';
import { FakeDb } from './fakeDb.js';

/** Deterministic bag-of-words "embedding" so semantic ranking is testable offline. */
const VOCAB = 'alpha beta flutter firebase react postgres attendance school payroll tea coffee database login bug deadline'.split(' ');
const vec = (t: string) => {
  const w = t.toLowerCase();
  return [...VOCAB.map((v): number => (w.includes(v) ? 1 : 0)), 0.01];
};
const fakeEmbed = async (texts: string[]) => ({ model: 'fake-embed', vectors: texts.map(vec) });

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
});

async function exchange(c: string, k: number, title: string, project: string | null, user: string, assistant: string, at: number) {
  await indexExchange({ db: db.asFirestore(), uid: 'u', conversationId: c, position: k, title, project, userText: user, assistantText: assistant, now: at, embedFn: fakeEmbed });
}

describe('conversation history index', () => {
  it('finds a decision made in an earlier conversation', async () => {
    await exchange('c1', 0, 'Alpha backend', projectSlug('Project Alpha'), 'For Project Alpha we decided to use Firebase instead of Postgres because of offline sync', 'Agreed: Firebase.', 1000);
    await exchange('c2', 0, 'Tea', null, 'What tea goes with breakfast?', 'English breakfast tea.', 2000);
    const hits = await searchHistory({ db: db.asFirestore(), uid: 'u', query: { text: 'What did we decide about Project Alpha database?' }, embedFn: fakeEmbed });
    expect(hits[0]).toMatchObject({ conversationId: 'c1', title: 'Alpha backend' });
    expect(hits.find((h) => h.conversationId === 'c2')).toBeUndefined();
    expect(hits[0].excerpt).toContain('Firebase');
  });

  it('keeps projects apart when a project is in focus', async () => {
    await exchange('c1', 0, 'Alpha login', 'p_alpha', 'Alpha login bug: tokens expire early', 'Fix the refresh.', 1000);
    await exchange('c2', 0, 'Beta login', 'p_beta', 'Beta login bug: password reset fails', 'Check SMTP.', 2000);
    const hits = await searchHistory({ db: db.asFirestore(), uid: 'u', query: { text: 'the login bug' }, focusProject: 'p_beta', embedFn: fakeEmbed });
    expect(hits.map((h) => h.conversationId)).toEqual(['c2']);
  });

  it('excludes turns already in the context window', async () => {
    await exchange('cur', 0, 'Now', null, 'firebase rules question', 'answer', 1000);
    await exchange('cur', 2, 'Now', null, 'firebase rules again', 'answer', 2000);
    const hits = await searchHistory({ db: db.asFirestore(), uid: 'u', query: { text: 'firebase rules' }, exclude: (e) => e.c === 'cur' && e.k >= 2, embedFn: fakeEmbed });
    expect(hits.map((h) => h.excerpt)).toEqual([expect.stringContaining('rules question')]);
  });

  it('shards the index and removes or re-tags a conversation everywhere', async () => {
    for (let i = 0; i < SHARD_MAX + 5; i++) await exchange(i % 2 ? 'odd' : 'even', i, 'Chat', null, `message number ${i} about coffee`, 'ok', i);
    const shards = [...db.docs.keys()].filter((p) => p.startsWith('users/u/convIndex/s'));
    expect(shards.length).toBe(2);
    expect((await loadIndex(db.asFirestore(), 'u')).length).toBe(SHARD_MAX + 5);
    await tagConversationProject(db.asFirestore(), 'u', 'odd', 'p_alpha');
    expect((await loadIndex(db.asFirestore(), 'u')).filter((e) => e.c === 'odd').every((e) => e.p === 'p_alpha')).toBe(true);
    const removed = await removeConversationFromIndex(db.asFirestore(), 'u', 'odd');
    expect(removed).toBe(62);
    expect((await loadIndex(db.asFirestore(), 'u')).every((e) => e.c === 'even')).toBe(true);
  });
});

describe('project memory', () => {
  const brief = JSON.stringify({ description: 'School attendance app', aliases: ['the attendance app'], technologies: ['Flutter', 'Firebase'], architecture: 'Mobile client + Firestore', progress: 'Login done', decisions: ['Firebase for offline sync'], bugs: ['Login bug on Android'], tasks: ['Reports screen'] });

  it('creates a brief and detects the project by name or alias', async () => {
    const slug = await updateProjectMemory({ db: db.asFirestore(), uid: 'u', name: 'Project Alpha', conversationId: 'c1', conversationTitle: 'Alpha', userText: 'x', assistantText: 'y', complete: async () => brief, embedFn: fakeEmbed });
    expect(slug).toBe('p_alpha');
    const projects = await loadProjects(db.asFirestore(), 'u');
    expect(projects[0].data).toMatchObject({ name: 'Project Alpha', technologies: ['Flutter', 'Firebase'], conversations: [{ id: 'c1' }] });
    expect(namesProject('Any updates on alpha?', projects[0].data)).toBe(true);
    expect(namesProject('how is the attendance app going', projects[0].data)).toBe(true);
    expect(namesProject('Explain the alphabet', projects[0].data)).toBe(false);
    expect(detectFocus({ text: 'What did we decide about Project Alpha?', projects })).toMatchObject({ slug: 'p_alpha', reason: 'named' });
    expect(detectFocus({ text: 'Unrelated question', projects })).toBeNull();
    expect(detectFocus({ text: 'next step?', projects, conversationProject: 'p_alpha' })).toMatchObject({ reason: 'conversation' });
  });

  it('deleting the only conversation removes an automatic brief; otherwise it is rebuilt', async () => {
    const opts = { db: db.asFirestore(), uid: 'u', name: 'Project Alpha', conversationTitle: 'Alpha', userText: 'x', assistantText: 'y', complete: async () => brief, embedFn: fakeEmbed };
    await updateProjectMemory({ ...opts, conversationId: 'c1' });
    expect(await removeConversationFromProjects({ db: db.asFirestore(), uid: 'u', conversationId: 'c1' })).toEqual({ rebuilt: 0, deleted: 1 });
    expect(await loadProjects(db.asFirestore(), 'u')).toEqual([]);

    await updateProjectMemory({ ...opts, conversationId: 'c1' });
    await updateProjectMemory({ ...opts, conversationId: 'c2' });
    db.docs.set('users/u/conversations/c2', { title: 'Alpha 2', summary: 'Discussed the reports screen in Flutter.' });
    const rebuiltBrief = JSON.stringify({ description: 'Rebuilt', technologies: ['Flutter'], decisions: [], bugs: [], tasks: ['Reports screen'] });
    const r = await removeConversationFromProjects({ db: db.asFirestore(), uid: 'u', conversationId: 'c1', complete: async () => rebuiltBrief });
    expect(r).toEqual({ rebuilt: 1, deleted: 0 });
    const p = (await loadProjects(db.asFirestore(), 'u'))[0].data;
    expect(p.conversations.map((c) => c.id)).toEqual(['c2']);
    expect(p).toMatchObject({ description: 'Rebuilt', technologies: ['Flutter'], bugs: [] });
  });
});

describe('memory selection', () => {
  const mem = (id: string, text: string, extra: Partial<LoadedMemory['data']> = {}): LoadedMemory => ({
    id,
    data: { text, category: 'fact', reason: '', active: true, origin: 'auto', ...extra },
  });

  it('never mixes memories from another project', () => {
    const all = [
      mem('a', 'Alpha uses Flutter', { project: 'p_alpha', category: 'project' }),
      mem('b', 'Beta uses React', { project: 'p_beta', category: 'project' }),
      mem('c', 'Prefers concise answers', { category: 'preference', importance: 4 }),
    ];
    const ids = (focus: string | null) => selectRelevant(all, { text: 'what stack do we use' }, { focusProject: focus }).map((m) => m.id).sort();
    expect(ids('p_alpha')).toEqual(['a', 'c']);
    expect(ids('p_beta')).toEqual(['b', 'c']);
    expect(ids(null)).toEqual(['c']);
  });

  it('always includes important instructions and filters the rest by relevance', () => {
    const many = Array.from({ length: 40 }, (_, i) => mem(`f${i}`, `Unrelated fact number ${i} about gardening`));
    const all = [...many, mem('i', 'Always answer in British English', { category: 'instruction', importance: 5 }), mem('t', 'Drinks green tea every morning', { importance: 2 })];
    const picked = selectRelevant(all, { text: 'what tea do I drink in the morning' }).map((m) => m.id);
    expect(picked[0]).toBe('i');
    expect(picked).toContain('t');
    expect(picked.length).toBeLessThanOrEqual(12);
  });
});

describe('rolling conversation summary', () => {
  it('folds older turns into the summary and keeps recent ones verbatim', async () => {
    const conv = 'users/u/conversations/c1';
    const total = VERBATIM_TURNS + 10;
    for (let i = 0; i < total; i++) db.docs.set(`${conv}/messages/m${String(i).padStart(3, '0')}`, { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, createdAt: String(i).padStart(3, '0') });
    let seen = '';
    const ok = await updateHistorySummary({
      db: db.asFirestore(),
      uid: 'u',
      conversationId: 'c1',
      state: {},
      total,
      complete: async (msgs) => {
        seen = String(msgs[1].content);
        return 'Summary of turns 0-9';
      },
    });
    expect(ok).toBe(true);
    expect(seen).toContain('turn 0');
    expect(seen).toContain('turn 9');
    expect(seen).not.toContain('turn 10');
    expect(db.docs.get(conv)).toMatchObject({ historySummary: 'Summary of turns 0-9', historySummaryCount: 10 });
    // nothing new to fold yet
    expect(await updateHistorySummary({ db: db.asFirestore(), uid: 'u', conversationId: 'c1', state: { historySummary: 'x', historySummaryCount: 10 }, total: total + 2, complete: async () => 'y' })).toBe(false);
  });
});
