import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderChunk } from '../server/providers/types.js';
import { ProviderError } from '../server/providers/types.js';
import { FakeDb } from './fakeDb.js';
import { fakeModel } from './helpers.js';

// The real chat engine, routing and model health; the AI provider is scripted per model.
const G36 = 'gemini:gemini-3.6-flash';
const G38 = 'gemini:gemini-3.8-flash';
const LITE = 'gemini:gemini-3.5-flash-lite';
const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const calls: string[] = [];
let hanging = new Set<string>();
let db: FakeDb;

const gem = (id: string) => ({ ...fakeModel(id, { contextLength: 1_000_000, free: true, vision: true, pricing: { prompt: 0, completion: 0 } }), provider: 'gemini' as const });
vi.mock('../server/providers/registry.js', async (orig) => ({
  ...(await orig<object>()),
  getCatalog: async () => ({ models: [gem(G36), gem(G38), gem(LITE), fakeModel(ULTRA, { free: true })], defaultModel: G36, fallbackModels: [], paidAvailable: false }),
  providerFor: (model: string) => ({
    id: model.startsWith('gemini:') ? 'gemini' : 'openrouter',
    stream: async function* (req: { model: string; firstByteTimeoutMs?: number }): AsyncGenerator<ProviderChunk> {
      calls.push(`${req.model}${req.firstByteTimeoutMs ? ` (wait ${req.firstByteTimeoutMs} ms)` : ''}`);
      if (hanging.has(req.model)) throw new ProviderError('timeout', 'Gemini took too long to start responding.', 504);
      yield { type: 'delta', text: `answer from ${req.model}` };
      yield { type: 'finish', reason: 'stop', model: req.model };
    },
  }),
}));
vi.mock('../server/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => null }));
vi.mock('../server/admin.js', async (orig) => ({ ...(await orig<object>()), adminConfigured: () => true, adminDb: async () => db.asFirestore() }));

const { chatRequestSchema, runChat } = await import('../server/chat/engine.js');
const { clearUsageCache } = await import('../server/usage/allowance.js');
const { resetHealth } = await import('../server/providers/health.js');
const { modelConfig } = await import('../server/config/models.js');
import type { ChatRequestBody, StreamEvent } from '../server/shared/types.js';

const UID = 'u1';
const CID = 'c1';
const user = { uid: UID, email: 'u@example.com', emailVerified: true, provider: 'google.com', phoneVerified: true, authTime: 0 };
let n = 0;

async function chat(model: string, content = 'Explain recursion') {
  const jobs: Promise<unknown>[] = [];
  const body = chatRequestSchema.parse({
    conversationId: CID,
    assistantMessageId: `r${++n}`,
    model,
    messages: [{ role: 'user', content }],
    options: { webSearch: false, autoSearch: false, searchMode: 'manual', memory: false, documentIds: [], projectId: null },
  }) as ChatRequestBody;
  const res = await runChat({ db: db.asFirestore(), user, admin: false } as unknown as Parameters<typeof runChat>[0], body, new AbortController().signal, (p) => jobs.push(p));
  const text = await res.text();
  await Promise.all(jobs);
  const events = text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as StreamEvent);
  const answer = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
  const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }> | undefined;
  return { answer, model: done?.model, error: events.find((e) => e.type === 'error') };
}

beforeEach(() => {
  db = new FakeDb();
  calls.length = 0;
  hanging = new Set();
  resetHealth();
  clearUsageCache();
  db.docs.set(`users/${UID}`, { settings: {} });
  db.docs.set(`users/${UID}/conversations/${CID}`, { title: 'Test', titleSet: true, messageCount: 0 });
});

describe('Gemini 3.6 Flash as the default, 3.8 Flash as an alternative', () => {
  it('the default answers new conversations directly', async () => {
    process.env.GEMINI_API_KEY ??= 'x';
    expect(modelConfig().defaultModel).toBe(G36);
    const r = await chat(G36);
    expect(r.answer).toBe(`answer from ${G36}`);
    expect(calls).toEqual([`${G36} (wait 15000 ms)`]);
  });

  it('a manually selected 3.8 Flash is used when it works (existing conversations keep their model)', async () => {
    const r = await chat(G38);
    expect(r.model).toBe(G38);
    expect(calls.map((c) => c.split(' ')[0])).toEqual([G38]);
  });

  it('3.8 Flash not responding: 3.6 Flash answers the same message, then 3.8 rests and is not waited for again', async () => {
    hanging.add(G38);
    const first = await chat(G38);
    expect(first.answer).toBe(`answer from ${G36}`);
    expect(first.error).toBeUndefined();
    // the wait for the hanging model is limited because a fallback was available
    expect(calls).toEqual([`${G38} (wait 15000 ms)`, `${G36} (wait 15000 ms)`]);

    calls.length = 0;
    const second = await chat(G38);
    expect(second.answer).toBe(`answer from ${G36}`);
    expect(calls.map((c) => c.split(' ')[0])).toEqual([G36]); // 3.8 not tried first again
  });

  it('3.8 recovers: after its rest it is tried again, and a success clears it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      hanging.add(G38);
      await chat(G38);
      hanging.clear();
      vi.setSystemTime(Date.now() + 4 * 60_000); // first rest is 3 minutes
      calls.length = 0;
      const r = await chat(G38);
      expect(r.model).toBe(G38);
      expect(calls.map((c) => c.split(' ')[0])).toEqual([G38]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('all Gemini models down: a free OpenRouter model answers (never a paid one)', async () => {
    hanging = new Set([G36, G38, LITE]);
    const r = await chat(G36);
    expect(r.answer).toBe(`answer from ${ULTRA}`);
    expect(calls.every((c) => c.startsWith('gemini:') || c.includes(':free'))).toBe(true);
  });
});
