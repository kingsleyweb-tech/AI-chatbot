import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderChunk } from '../server/providers/types.js';
import { ProviderError } from '../server/providers/types.js';
import { FakeDb } from './fakeDb.js';
import { fakeModel } from './helpers.js';

// The AI provider is replaced by a scripted stream; everything else (routing,
// prompt building, persistence) is the real chat engine.
const MODEL = 'gemini:test-flash';
let script: (signal: AbortSignal) => AsyncGenerator<ProviderChunk>;
vi.mock('../server/providers/registry.js', () => ({
  getCatalog: async () => ({ models: [fakeModel(MODEL, { contextLength: 100_000, free: true, pricing: { prompt: 0, completion: 0 } })], defaultModel: MODEL, fallbackModels: [], paidAvailable: false }),
  providerFor: () => ({ id: 'gemini', stream: (req: { signal: AbortSignal }) => script(req.signal) }),
}));
vi.mock('../server/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => null }));

const { chatRequestSchema, runChat } = await import('../server/chat/engine.js');
import type { ChatRequestBody, StreamEvent } from '../server/shared/types.js';

const UID = 'u1';
const CID = 'c1';
const conv = `users/${UID}/conversations/${CID}`;
let db: FakeDb;
let jobs: Promise<unknown>[];

const user = { uid: UID, email: 'u@example.com', emailVerified: true, provider: 'google.com', phoneVerified: true, authTime: 0 };
const ctx = () => ({ db: db.asFirestore(), user, admin: false }) as unknown as Parameters<typeof runChat>[0];

function body(replyId: string, messages: { role: 'user' | 'assistant'; content: string }[]): ChatRequestBody {
  return chatRequestSchema.parse({
    conversationId: CID,
    assistantMessageId: replyId,
    model: MODEL,
    messages,
    options: { webSearch: false, autoSearch: false, searchMode: 'manual', memory: false, documentIds: [], projectId: null },
  }) as ChatRequestBody;
}

async function* reply(text: string): AsyncGenerator<ProviderChunk> {
  for (const part of text.split(' ')) yield { type: 'delta', text: part + ' ' };
  yield { type: 'finish', reason: 'stop', model: MODEL };
}

/** Run one chat request, read the whole response like the browser, and wait for its background work. */
async function chat(replyId: string, messages: { role: 'user' | 'assistant'; content: string }[], signal = new AbortController().signal) {
  const res = await runChat(ctx(), body(replyId, messages), signal, (p) => jobs.push(p));
  const text = await res.text();
  await Promise.all(jobs);
  const events = text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as StreamEvent);
  return events;
}

const stored = () =>
  db
    .under(`${conv}/messages/`)
    .map((p) => ({ id: p.split('/').pop()!, ...(db.docs.get(p) as { role: string; content: string; status: string }) }));

/** A user message as the browser writes it, before calling the server. */
function addUser(id: string, content: string) {
  db.docs.set(`${conv}/messages/${id}`, { role: 'user', content, status: 'complete', createdAt: new Date().toISOString() });
}

beforeEach(() => {
  db = new FakeDb();
  jobs = [];
  db.docs.set(`users/${UID}`, { settings: {} });
  db.docs.set(conv, { title: 'Test', titleSet: true, messageCount: 0 });
});

describe('chat replies are stored permanently', () => {
  it('stores the reply before the response ends, and tells the browser', async () => {
    script = () => reply('Hello there friend');
    addUser('m1', 'hi');
    const events = await chat('r1', [{ role: 'user', content: 'hi' }]);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'saved', ok: true });
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ role: 'assistant', content: 'Hello there friend ', status: 'complete' });
    expect(db.docs.get(conv)).toMatchObject({ messageCount: 1 });
  });

  it('ten exchanges in one conversation: every message stays, none is overwritten', async () => {
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (let i = 1; i <= 10; i++) {
      addUser(`u${i}`, `question ${i}`);
      history.push({ role: 'user', content: `question ${i}` });
      script = () => reply(`answer ${i}`);
      await chat(`a${i}`, history);
      history.push({ role: 'assistant', content: `answer ${i} ` });
    }
    const all = stored();
    expect(all.filter((m) => m.role === 'user')).toHaveLength(10);
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(10);
    for (let i = 1; i <= 10; i++) {
      expect(db.docs.get(`${conv}/messages/u${i}`)).toMatchObject({ content: `question ${i}` });
      expect(db.docs.get(`${conv}/messages/a${i}`)).toMatchObject({ content: `answer ${i} `, status: 'complete' });
    }
  });

  it('the reply exists as "processing" while it is being generated', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = async function* () {
      yield { type: 'delta', text: 'partial ' };
      await gate;
      yield { type: 'delta', text: 'rest' };
    };
    addUser('m1', 'hi');
    const res = await runChat(ctx(), body('r1', [{ role: 'user', content: 'hi' }]), new AbortController().signal, (p) => jobs.push(p));
    const reading = res.text();
    await vi.waitFor(() => expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ status: 'processing', role: 'assistant' }));
    release();
    await reading;
    await Promise.all(jobs);
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ status: 'complete', content: 'partial rest' });
  });

  it('a provider failure keeps the user message; retrying replaces the failed reply instead of duplicating it', async () => {
    script = async function* () {
      yield* [];
      throw new ProviderError('provider_error', 'Gemini is unavailable.', 503);
    };
    addUser('m1', 'hi');
    const failed = await chat('r1', [{ role: 'user', content: 'hi' }]);
    expect(failed.some((e) => e.type === 'error')).toBe(true);
    expect(db.docs.get(`${conv}/messages/m1`)).toMatchObject({ role: 'user', content: 'hi' });
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ status: 'error', content: '' });

    script = () => reply('Recovered answer');
    await chat('r1', [{ role: 'user', content: 'hi' }]);
    const all = stored();
    expect(all.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(all.filter((m) => m.role === 'assistant')).toEqual([expect.objectContaining({ id: 'r1', status: 'complete', content: 'Recovered answer ' })]);
    expect(db.docs.get(conv)).toMatchObject({ messageCount: 1 });
  });

  it('an interrupted stream (browser gone) keeps the partial reply and the user message', async () => {
    const abort = new AbortController();
    script = async function* (signal) {
      yield { type: 'delta', text: 'Half an ' };
      abort.abort();
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      yield { type: 'delta', text: 'answer' };
    };
    addUser('m1', 'hi');
    await chat('r1', [{ role: 'user', content: 'hi' }], abort.signal);
    expect(db.docs.get(`${conv}/messages/m1`)).toMatchObject({ content: 'hi' });
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ status: 'stopped', content: 'Half an ' });
  });

  it('when the database write fails, the browser is told so it can store the reply itself', async () => {
    script = () => reply('Answer');
    addUser('m1', 'hi');
    const realCommit = db.commit.bind(db);
    let calls = 0;
    db.commit = async (writes) => {
      calls++;
      if (writes.some((w) => w.path.endsWith('/messages/r1') && w.op === 'set' && 'merge' in w && w.merge)) throw new Error('timeout');
      return realCommit(writes);
    };
    const events = await chat('r1', [{ role: 'user', content: 'hi' }]);
    expect(events.at(-1)).toEqual({ type: 'saved', ok: false });
    expect(calls).toBeGreaterThanOrEqual(3); // placeholder + two attempts
    expect(db.docs.get(`${conv}/messages/m1`)).toMatchObject({ content: 'hi' });
  });

  it('a conversation deleted while its reply was generating stays deleted', async () => {
    script = async function* () {
      yield { type: 'delta', text: 'Answer' };
      // the user deletes the conversation (and its messages) meanwhile
      for (const p of db.under(conv)) db.docs.delete(p);
    };
    addUser('m1', 'hi');
    const events = await chat('r1', [{ role: 'user', content: 'hi' }]);
    expect(events.at(-1)).toEqual({ type: 'saved', ok: true });
    expect(db.under(conv)).toEqual([]);
  });

  it('separate conversations never receive each other’s replies', async () => {
    db.docs.set(`users/${UID}/conversations/c2`, { title: 'Other', titleSet: true, messageCount: 0 });
    script = () => reply('for c1');
    addUser('m1', 'hi');
    await chat('r1', [{ role: 'user', content: 'hi' }]);
    expect(db.under(`users/${UID}/conversations/c2/messages/`)).toEqual([]);
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ content: 'for c1 ' });
  });
});
