import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeModel } from './helpers.js';
import { evaluateAccess } from '../server/access.js';
import { buildSystemPrompt, toProviderMessages } from '../server/chat/prompt.js';
import { chunkSections } from '../server/docs/chunk.js';
import { cosine, lexicalScore, rank, tokenize } from '../server/embeddings.js';
import { decodeFields, encodeFields, fieldPath, SERVER_TIME } from '../server/firestore.js';
import { mapError, mapModel, OpenRouterProvider } from '../server/providers/openrouter.js';
import { fallbackChain } from '../server/providers/registry.js';
import { parseSSE } from '../server/shared/sse.js';
import type { ModelInfo } from '../server/shared/types.js';
import { parseJsonObject, stripThinking } from '../server/utility.js';

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      parts.forEach((p) => c.enqueue(enc.encode(p)));
      c.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('parseSSE', () => {
  it('parses events split across arbitrary chunk boundaries', async () => {
    const events = await collect(parseSSE(streamOf('data: {"a"', ':1}\n\n: keep-alive\n\ndata: second\r\n\r\ndata: [DO', 'NE]\n\n')));
    expect(events).toEqual(['{"a":1}', 'second', '[DONE]']);
  });

  it('joins multi-line data and flushes a trailing event without a blank line', async () => {
    expect(await collect(parseSSE(streamOf('data: line1\ndata: line2\n\ndata: tail')))).toEqual(['line1\nline2', 'tail']);
  });

  it('handles multi-byte UTF-8 split between chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n\n');
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 8));
        c.enqueue(bytes.slice(8));
        c.close();
      },
    });
    expect(await collect(parseSSE(s))).toEqual(['héllo']);
  });
});

describe('OpenRouter mapping', () => {
  it('maps catalog entries with capabilities and per-million pricing', () => {
    const m = mapModel(
      {
        id: 'acme/vision-1',
        name: 'Acme Vision',
        context_length: 128000,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['tools', 'reasoning', 'response_format'],
      },
      ['acme/vision-1'],
    );
    expect(m).toMatchObject({
      vendor: 'acme',
      free: false,
      featured: true,
      contextLength: 128000,
      pricing: { prompt: 1, completion: 2 },
      capabilities: { vision: true, tools: true, reasoning: true, structuredOutput: true },
    });
  });

  it('treats :free models as free and text-only by default', () => {
    const m = mapModel({ id: 'acme/small:free', name: 'Small (free)' }, []);
    expect(m.free).toBe(true);
    expect(m.capabilities.vision).toBe(false);
    expect(m.name).toBe('Small (free)');
  });

  it('reads audio, file and output modalities from provider metadata', () => {
    const omni = mapModel(
      { id: 'acme/omni:free', name: 'Omni', architecture: { input_modalities: ['text', 'image', 'audio', 'file'], output_modalities: ['text', 'image'] } },
      [],
    );
    expect(omni.capabilities).toMatchObject({ vision: true, audioInput: true, fileInput: true, imageOutput: true, audioOutput: false });
    expect(omni.outputModalities).toEqual(['text', 'image']);
    expect(mapModel({ id: 'cohere/north-mini-code:free', name: 'North' }, []).capabilities.code).toBe(true);
    expect(omni.capabilities.code).toBe(false);
  });

  it.each([
    [401, '{}', 'invalid_key', false],
    [402, '{}', 'insufficient_credits', true],
    [429, '{}', 'rate_limited', true],
    [404, '{"error":{"message":"No endpoints found"}}', 'model_unavailable', true],
    [400, '{"error":{"message":"This endpoint does not support image input"}}', 'unsupported_input', true],
    [400, '{"error":{"message":"maximum context length exceeded"}}', 'context_too_long', false],
    [503, 'upstream down', 'provider_error', true],
    [400, 'nonsense', 'bad_request', false],
  ])('maps HTTP %i to %s', (status, body, code, fallbackable) => {
    const err = mapError(status, body);
    expect(err.code).toBe(code);
    expect(err.fallbackable).toBe(fallbackable);
  });
});

const model = (id: string, opts: Parameters<typeof fakeModel>[1] = {}): ModelInfo => fakeModel(id, opts);

describe('fallbackChain', () => {
  afterEach(() => {
    delete process.env.FALLBACK_MODELS;
  });

  it('puts the requested model first and appends fallbacks without duplicates', () => {
    process.env.FALLBACK_MODELS = 'b/two:free,a/one:free';
    const catalog = [model('a/one:free'), model('b/two:free')];
    expect(fallbackChain('a/one:free', catalog, { needsVision: false, paidAvailable: true }).chain).toEqual(['a/one:free', 'b/two:free']);
  });

  it('skips paid models, whatever the account holds', () => {
    process.env.FALLBACK_MODELS = 'b/two:free';
    const catalog = [model('p/paid'), model('b/two:free')];
    const r = fallbackChain('p/paid', catalog, { needsVision: false, paidAvailable: true });
    expect(r.chain).toEqual(['b/two:free']);
    expect(r.skipped[0]).toMatchObject({ id: 'p/paid', reason: 'not a free model' });
  });

  it('keeps only vision models when images are attached and drops unknown ids', () => {
    process.env.FALLBACK_MODELS = 'v/see:free,gone/model:free';
    const catalog = [model('t/text:free'), model('v/see:free', { vision: true })];
    const r = fallbackChain('t/text:free', catalog, { needsVision: true, paidAvailable: null });
    expect(r.chain).toEqual(['v/see:free']);
    expect(r.skipped.map((s) => s.id)).toEqual(['t/text:free', 'gone/model:free']);
  });
});

describe('OpenRouterProvider.stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('normalizes deltas, reasoning, usage and finish; sends the key only server-side', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const sse = [
      'data: {"model":"x/y:free","choices":[{"delta":{"reasoning":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn(async () => new Response(streamOf(...sse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const chunks = await collect(new OpenRouterProvider().stream({ model: 'x/y:free', messages: [{ role: 'user', content: 'hi' }] }));
    expect(chunks).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'usage', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7, cost: undefined } },
      { type: 'finish', reason: 'stop', model: 'x/y:free' },
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
  });

  it('throws a typed error for HTTP failures', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Rate limit"}}', { status: 429 })));
    await expect(collect(new OpenRouterProvider().stream({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('surfaces in-stream provider errors', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf('data: {"error":{"code":402,"message":"credits"}}\n\n'), { status: 200 })));
    await expect(collect(new OpenRouterProvider().stream({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: 'insufficient_credits' });
  });

  it('refuses to run without a configured key', async () => {
    await expect(collect(new OpenRouterProvider().stream({ model: 'm', messages: [] }))).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('chunkSections', () => {
  it('keeps short sections whole with their reference', () => {
    expect(chunkSections([{ ref: 'p. 1', text: 'Hello world.' }, { ref: 'p. 2', text: '   ' }])).toEqual([{ index: 0, ref: 'p. 1', text: 'Hello world.' }]);
  });

  it('splits long text into overlapping chunks that cover everything', () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} talks about topic ${i % 7}.`).join(' ');
    const chunks = chunkSections([{ ref: 'Sheet1', text: sentences }], 1000, 150);
    expect(chunks.length).toBeGreaterThan(5);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(1000);
    });
    expect(chunks.at(-1)!.text).toContain('Sentence number 199');
    // overlap: the start of chunk 2 appears at the end of chunk 1
    expect(chunks[0].text).toContain(chunks[1].text.slice(0, 40));
  });
});

describe('retrieval scoring', () => {
  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it('tokenizes without stop words and scores lexical overlap', () => {
    expect(tokenize('What is the capital of France?')).toEqual(['capital', 'france']);
    expect(lexicalScore('capital of France', 'Paris is the capital of France')).toBe(1);
    expect(lexicalScore('capital of France', 'Bananas are yellow')).toBe(0);
  });

  it('uses vectors only when the embedding model matches, else lexical', () => {
    const items = [
      { text: 'dogs and cats', vector: [0, 1], model: 'm1' },
      { text: 'quarterly revenue report', vector: [1, 0], model: 'm1' },
      { text: 'revenue numbers', vector: [1, 0], model: 'other' },
    ];
    const ranked = rank(items, { text: 'revenue', vector: [1, 0], model: 'm1' }, (x) => x);
    expect(ranked[0].item.text).toBe('quarterly revenue report');
    expect(ranked[1].score).toBeCloseTo(0.8); // lexical fallback, discounted
  });
});

describe('evaluateAccess', () => {
  const boot = ['owner@example.com'];
  it('denies unverified or missing emails', () => {
    expect(evaluateAccess('owner@example.com', false, null, boot)).toEqual({ ok: false, admin: false });
    expect(evaluateAccess(null, true, null, boot).ok).toBe(false);
  });
  it('allows bootstrap admins case-insensitively', () => {
    expect(evaluateAccess('Owner@Example.com', true, null, boot)).toEqual({ ok: true, admin: true });
  });
  it('allows listed users and denies everyone else', () => {
    const cfg = { allowedEmails: ['friend@example.com'], adminEmails: ['ops@example.com'] };
    expect(evaluateAccess('friend@example.com', true, cfg, boot)).toEqual({ ok: true, admin: false });
    expect(evaluateAccess('ops@example.com', true, cfg, boot)).toEqual({ ok: true, admin: true });
    expect(evaluateAccess('stranger@example.com', true, cfg, boot)).toEqual({ ok: false, admin: false });
  });
});

describe('prompt building', () => {
  it('includes personalization, memory, documents and web instructions only when present', () => {
    const base = buildSystemPrompt({ settings: {}, now: new Date('2026-01-02T00:00:00Z') });
    expect(base).toContain('Current date: 2026-01-02');
    expect(base).not.toContain('Long-term memory');
    const full = buildSystemPrompt({
      settings: { aboutMe: 'Pilot', customInstructions: 'Use metric', language: 'French', responseStyle: 'concise' },
      memories: '- Likes tea',
      documents: '[D1] report.pdf p. 2: ...',
      webResults: '[1] Example',
      projectName: 'Ops',
      projectInstructions: 'Be formal',
    });
    for (const s of ['Pilot', 'Use metric', 'Respond in French', 'Keep answers brief', 'Likes tea', '[D1]', 'Web search results', 'Project: Ops']) {
      expect(full).toContain(s);
    }
  });

  it('reports a failed web search instead of results', () => {
    expect(buildSystemPrompt({ settings: {}, webSearchFailed: 'timeout' })).toContain("couldn't search");
    // Voice Mode: replies are written to be heard (no Markdown), short, and keep the conversation's context
    const spoken = buildSystemPrompt({ settings: {}, voice: true });
    expect(spoken).toContain('## Spoken conversation');
    expect(spoken).toMatch(/Do not use Markdown/);
    expect(spoken.indexOf('## Spoken conversation')).toBeGreaterThan(spoken.indexOf('Format responses in Markdown'));
    expect(buildSystemPrompt({ settings: {} })).not.toContain('Spoken conversation');
  });

  it('trims old turns to the budget but always keeps the latest turn', () => {
    const turns = Array.from({ length: 31 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'x'.repeat(4000) }));
    const { messages, droppedTurns } = toProviderMessages('sys', turns, { vision: false, budgetTokens: 5000 });
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(droppedTurns).toBeGreaterThan(20);
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('sends images only to vision models, otherwise adds a note', () => {
    const turns = [{ role: 'user' as const, content: 'what is this', attachments: [{ kind: 'image' as const, dataUrl: 'data:image/png;base64,AA', name: 'a.png', mime: 'image/png' }] }];
    const vis = toProviderMessages('s', turns, { vision: true, budgetTokens: 10000 });
    expect(Array.isArray(vis.messages[1].content)).toBe(true);
    const txt = toProviderMessages('s', turns, { vision: false, budgetTokens: 10000 });
    expect(txt.messages[1].content).toContain('cannot view images');
  });
});

describe('Firestore REST encoding', () => {
  it('round-trips values and omits server timestamps / undefined', () => {
    const fields = encodeFields({ a: 1, b: 1.5, c: 'x', d: true, e: null, f: [1, 'y'], g: { h: 2 }, t: SERVER_TIME, u: undefined });
    expect(fields).not.toHaveProperty('t');
    expect(fields).not.toHaveProperty('u');
    expect(decodeFields(fields)).toEqual({ a: 1, b: 1.5, c: 'x', d: true, e: null, f: [1, 'y'], g: { h: 2 } });
  });

  it('quotes non-identifier field path segments', () => {
    expect(fieldPath('models', 'google_gemma', 'tokens')).toBe('models.google_gemma.tokens');
    expect(fieldPath('models', 'a-b')).toBe('models.`a-b`');
  });
});

describe('utility helpers', () => {
  it('extracts JSON objects from fenced or chatty model output', () => {
    expect(parseJsonObject<{ ops: unknown[] }>('Sure!\n```json\n{"ops":[]}\n```')).toEqual({ ops: [] });
    expect(parseJsonObject('no json here')).toBeNull();
    expect(parseJsonObject('{bad json}')).toBeNull();
  });
  it('strips inline reasoning tags', () => {
    expect(stripThinking('<think>hmm</think> Title here')).toBe('Title here');
  });
});
