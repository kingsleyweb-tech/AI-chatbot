import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderChunk } from '../server/providers/types.js';
import { ProviderError } from '../server/providers/types.js';
import { FakeDb } from './fakeDb.js';
import { fakeModel } from './helpers.js';

// The real chat engine and allowance engine; the AI provider is a scripted stream and the
// server identity is the in-memory database.
const MODEL = 'gemini:gemini-3.8-flash';
let script: (signal: AbortSignal) => AsyncGenerator<ProviderChunk>;
let lastReq: { reasoning?: boolean } | null = null;
let db: FakeDb;
vi.mock('../server/providers/registry.js', () => ({
  getCatalog: async () => ({ models: [fakeModel(MODEL, { contextLength: 100_000, free: true, pricing: { prompt: 0, completion: 0 } })], defaultModel: MODEL, fallbackModels: [], paidAvailable: false }),
  providerFor: () => ({
    id: 'gemini',
    stream: (req: { signal: AbortSignal; reasoning?: boolean }) => {
      lastReq = req;
      return script(req.signal);
    },
  }),
}));
vi.mock('../server/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => null }));
vi.mock('../server/admin.js', async (orig) => ({ ...(await orig<object>()), adminConfigured: () => true, adminDb: async () => db.asFirestore() }));

const { chatRequestSchema, runChat } = await import('../server/chat/engine.js');
const { clearUsageCache, USAGE_CONFIG_PATH, accountPath } = await import('../server/usage/allowance.js');
import type { ChatRequestBody, StreamEvent } from '../server/shared/types.js';
import type { UsageAccount } from '../server/usage/policy.js';

const UID = 'u1';
const CID = 'c1';
const conv = `users/${UID}/conversations/${CID}`;
let jobs: Promise<unknown>[];
const user = { uid: UID, email: 'u@example.com', emailVerified: true, provider: 'google.com', phoneVerified: true, authTime: 0 };
const ctx = (admin = false) => ({ db: db.asFirestore(), user, admin }) as unknown as Parameters<typeof runChat>[0];

function body(replyId: string, opts: Record<string, unknown> = {}): ChatRequestBody {
  return chatRequestSchema.parse({
    conversationId: CID,
    assistantMessageId: replyId,
    model: MODEL,
    messages: [{ role: 'user', content: (opts.text as string | undefined) ?? 'hello' }],
    options: { webSearch: false, autoSearch: false, searchMode: 'manual', memory: false, documentIds: [], projectId: null, ...opts, text: undefined },
  }) as ChatRequestBody;
}
async function* reply(text: string): AsyncGenerator<ProviderChunk> {
  for (const part of text.split(' ')) yield { type: 'delta', text: part + ' ' };
  yield { type: 'finish', reason: 'stop', model: MODEL };
}
async function chat(replyId: string, admin = false) {
  const res = await runChat(ctx(admin), body(replyId), new AbortController().signal, (p) => jobs.push(p));
  const text = await res.text();
  await Promise.all(jobs);
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as StreamEvent);
}
const chatUsed = () => (db.docs.get(accountPath(UID)) as UsageAccount | undefined)?.counters?.chat?.du ?? 0;
const setChatLimit = (daily: number) => {
  db.docs.set(USAGE_CONFIG_PATH, { profiles: { standard: { limits: { chat: { daily, weekly: null } } } } });
  clearUsageCache();
};

beforeEach(() => {
  db = new FakeDb();
  jobs = [];
  clearUsageCache();
  db.docs.set(`users/${UID}`, { settings: {} });
  db.docs.set(conv, { title: 'Test', titleSet: true, messageCount: 0 });
});

describe('allowances in chat', () => {
  it('counts each reply and tells the browser the new totals', async () => {
    script = () => reply('Hi there');
    const events = await chat('r1');
    const a = events.find((e) => e.type === 'allowance');
    expect(a).toMatchObject({ type: 'allowance', feature: { id: 'chat', daily: { used: 1 } } });
    expect(chatUsed()).toBe(1);
  });

  it('a used-up allowance is refused before anything starts (no reply placeholder, no model call)', async () => {
    setChatLimit(1);
    script = () => reply('one');
    await chat('r1');
    let called = false;
    script = () => {
      called = true;
      return reply('two');
    };
    const err = await runChat(ctx(), body('r2'), new AbortController().signal, (p) => jobs.push(p)).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'usage_limit', details: { feature: 'chat', period: 'daily' } });
    expect(called).toBe(false);
    expect(db.docs.has(`${conv}/messages/r2`)).toBe(false);
  });

  it('an accepted reply finishes even when the allowance runs out while it is being written', async () => {
    setChatLimit(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = async function* () {
      yield { type: 'delta', text: 'first half ' };
      await gate;
      yield { type: 'delta', text: 'second half' };
      yield { type: 'finish', reason: 'stop', model: MODEL };
    };
    const running = runChat(ctx(), body('r1'), new AbortController().signal, (p) => jobs.push(p)).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 20));
    // a second request while the first is still streaming: the allowance is now used up
    await expect(runChat(ctx(), body('r2'), new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'usage_limit' });
    release();
    await running;
    await Promise.all(jobs);
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ status: 'complete', content: 'first half second half' });
    expect(chatUsed()).toBe(1);
  });

  it('a reply that fails before any output gives its unit back; the retry is counted once', async () => {
    script = async function* () {
      yield* [];
      throw new ProviderError('provider_error', 'upstream down', 502);
    };
    await chat('r1');
    expect(chatUsed()).toBe(0);
    script = () => reply('works now');
    await chat('r1'); // the browser's Retry reuses the reply id
    expect(chatUsed()).toBe(1);
    await chat('r1'); // a repeated retry of a reply that was already counted
    expect(chatUsed()).toBe(1);
  });

  it('administrators are never limited by their allowance', async () => {
    setChatLimit(0);
    script = () => reply('ok');
    const events = await chat('r1', true);
    expect(events.find((e) => e.type === 'allowance')).toMatchObject({ feature: { limited: false } });
    expect(db.docs.get(`${conv}/messages/r1`)).toMatchObject({ status: 'complete' });
  });

  it('Deep Research counts against Web research, not Chat', async () => {
    script = () => reply('report');
    const res = await runChat(ctx(), body('r1', { deepResearch: true }), new AbortController().signal, (p) => jobs.push(p));
    await res.text();
    await Promise.all(jobs);
    const a = db.docs.get(accountPath(UID)) as UsageAccount;
    expect(a.counters?.research?.du).toBe(3);
    expect(a.counters?.chat).toBeUndefined();
  });

  it('a simple message uses the fast pathway and counts against Chat', async () => {
    script = () => reply('Hello!');
    await chat('r1');
    expect(lastReq?.reasoning).toBe(false);
    expect(chatUsed()).toBe(1);
    expect((db.docs.get(accountPath(UID)) as UsageAccount).counters?.reasoning).toBeUndefined();
  });

  const HARD = 'Solve 3x^2 - 5x + 2 = 0 and show the steps';
  const send = async (id: string, text: string) => {
    const res = await runChat(ctx(), body(id, { text }), new AbortController().signal, (p) => jobs.push(p));
    await res.text();
    await Promise.all(jobs);
  };

  it('a message that needs it uses Advanced Reasoning and counts against that allowance only', async () => {
    script = () => reply('x = 1 or x = 2/3');
    await send('r1', HARD);
    expect(lastReq?.reasoning).toBe(true);
    const a = db.docs.get(accountPath(UID)) as UsageAccount;
    expect(a.counters?.reasoning?.du).toBe(1);
    expect(a.counters?.chat).toBeUndefined();
  });

  it('with the Advanced Reasoning allowance used up, a hard question is still answered on the normal pathway', async () => {
    db.docs.set(USAGE_CONFIG_PATH, { profiles: { standard: { limits: { reasoning: { daily: 0, weekly: null } } } } });
    clearUsageCache();
    script = () => reply('x = 1 or x = 2/3');
    await send('r1', HARD);
    expect(lastReq?.reasoning).toBe(false);
    expect(chatUsed()).toBe(1);
  });

  it('a used-up Chat allowance does not block the other features, and the refusal lists them', async () => {
    setChatLimit(0);
    const err = await runChat(ctx(), body('r1'), new AbortController().signal, () => undefined).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'usage_limit', details: { feature: 'chat' } });
    const available = (err as { details: { available: { id: string }[] } }).details.available.map((a) => a.id);
    expect(available).toContain('research');
    expect(available).toContain('images');
    expect(available).not.toContain('chat');
    expect((err as Error).message).toContain('You can still use:');
    // Deep Research still works
    script = () => reply('report');
    const res = await runChat(ctx(), body('r2', { deepResearch: true }), new AbortController().signal, (p) => jobs.push(p));
    await res.text();
    await Promise.all(jobs);
    expect((db.docs.get(accountPath(UID)) as UsageAccount).counters?.research?.du).toBe(3);
  });
});
