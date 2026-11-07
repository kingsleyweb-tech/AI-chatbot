import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider, mapGeminiError, mapGeminiModel, toGeminiRequest } from '../server/providers/gemini.js';
import { providerFor } from '../server/providers/registry.js';
import { routeModel } from '../server/router/route.js';
import { detectTask } from '../server/router/task.js';
import { fakeModel } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_BILLING;
});

describe('Gemini provider', () => {
  it('routes gemini: ids to the Gemini provider and others to OpenRouter', () => {
    expect(providerFor('gemini:gemini-3.8-flash').id).toBe('gemini');
    expect(providerFor('nvidia/nemotron-3-ultra-550b-a55b:free').id).toBe('openrouter');
  });

  it('maps curated models only, free unless billing is declared paid', () => {
    const m = mapGeminiModel({ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] });
    expect(m).toMatchObject({ id: 'gemini:gemini-3.8-flash', provider: 'gemini', free: true, contextLength: 1048576 });
    expect(m?.capabilities.vision).toBe(true);
    expect(mapGeminiModel({ name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] })).toBeNull();
    expect(mapGeminiModel({ name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] })).toBeNull();
    process.env.GEMINI_BILLING = 'paid';
    expect(mapGeminiModel({ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] })?.free).toBe(false);
  });

  it('converts messages: system instruction, model role, merged turns, inline images', () => {
    const req = toGeminiRequest([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
      { role: 'assistant', content: 'b' },
    ]);
    expect(req.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(req.contents.map((c) => c.role)).toEqual(['user', 'model']);
    expect(req.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'QUJD' } });
  });

  it('maps errors', () => {
    expect(mapGeminiError(429, JSON.stringify({ error: { message: 'Quota exceeded ... limit: 0, model: x' } })).code).toBe('model_unavailable');
    const rl = mapGeminiError(429, JSON.stringify({ error: { message: 'Resource has been exhausted' } }));
    expect(rl.code).toBe('rate_limited');
    expect(rl.fallbackable).toBe(true);
    expect(mapGeminiError(403, '{}').code).toBe('invalid_key');
    expect(mapGeminiError(503, '{}').code).toBe('provider_error');
  });

  it('streams text, thoughts and usage from SSE', async () => {
    process.env.GEMINI_API_KEY ??= 'test';
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"hmm","thought":true}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}\n\n';
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const chunks = [];
    for await (const c of new GeminiProvider().stream({ model: 'gemini:gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(chunks).toContainEqual({ type: 'reasoning', text: 'hmm' });
    expect(chunks).toContainEqual({ type: 'delta', text: 'Hello' });
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({ usage: { totalTokens: 6, cost: 0 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-3.8-flash:streamGenerateContent');
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBeTruthy();
  });

  it('router falls back to a free Gemini model when free OpenRouter models are unavailable', () => {
    const catalog = [
      fakeModel('nvidia/nemotron-3-ultra-550b-a55b:free', { available: false }),
      fakeModel('nvidia/nemotron-3.5-super-vl:free', { vision: true, available: false }),
      { ...fakeModel('gemini:gemini-3.8-flash', { vision: true, free: true }), provider: 'gemini' },
    ];
    const r = routeModel('nvidia/nemotron-3-ultra-550b-a55b:free', detectTask([{ role: 'user', content: 'hi' }]), catalog, {
      paidAvailable: false,
    });
    expect(r.kind === 'ok' && r.chain[0]).toBe('gemini:gemini-3.8-flash');
  });
});
