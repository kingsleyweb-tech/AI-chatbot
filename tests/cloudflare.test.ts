import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminDb } from '../server/admin.js';
import { claimUserSlot, recordUsage, reserveNeurons, resetBudgetState, usagePath, utcDay } from '../server/cloudflare/budget.js';
import {
  cloudflareDailyLimitActive,
  imageSize,
  mapCloudflareError,
  resetCloudflareDailyLimit,
  setCloudflareFake,
  sniffImageMime,
  type CloudflareFake,
} from '../server/cloudflare/client.js';
import { normalizeAiConfig } from '../server/config/ai.js';
import { invalidateLimits } from '../server/config/limits.js';
import { decodeValue, encodeValue, type Firestore } from '../server/firestore.js';
import { editSize, ImageError, imageIdFor, runImageTurn } from '../server/images/generate.js';
import { checkImagePrompt, parseGuardVerdict, ruleCheck } from '../server/images/safety.js';
import { CHUNK_BYTES, imageWrites, loadImage, metaPath, splitChunks } from '../server/images/store.js';
import { CloudflareProvider, mapCloudflareModel } from '../server/providers/cloudflare.js';
import { routeModel } from '../server/router/route.js';
import { detectTask } from '../server/router/task.js';
import { imageModel, IMAGE_MODELS } from '../server/config/images.js';
import { FakeDb } from './fakeDb.js';
import { fakeModel } from './helpers.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-should-never-leak';

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  resetCloudflareDailyLimit();
  resetBudgetState();
  invalidateLimits();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCloudflareFake(null);
  setAdminDb(null);
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

describe('Cloudflare error mapping', () => {
  const body = (code: number, message: string) => JSON.stringify({ success: false, errors: [{ code, message }], result: null });
  it('maps the documented error shapes to typed errors without credentials or request ids', () => {
    expect(mapCloudflareError(401, body(10000, 'Authentication error')).code).toBe('invalid_key');
    expect(mapCloudflareError(400, body(7000, 'No route for that URI')).code).toBe('model_unavailable');
    const bad = mapCloudflareError(400, body(3030, 'AiError: AiError: 99999 is too large, max width is 2048 (44ee1710-6e8a-4277-85d5-0f4398b4bd23)'));
    expect(bad.code).toBe('bad_request');
    expect(bad.message).toContain('max width is 2048');
    expect(bad.message).not.toContain('44ee1710');
    expect(mapCloudflareError(429, body(0, 'Too many requests')).code).toBe('rate_limited');
    expect(mapCloudflareError(503, body(0, 'Service unavailable')).code).toBe('provider_error');
    for (const e of [mapCloudflareError(401, body(10000, `bad token ${TOKEN}`))]) expect(e.message).not.toContain(TOKEN);
  });
  it('recognises the used-up free daily allocation and remembers it until midnight UTC', () => {
    const e = mapCloudflareError(429, body(4006, 'you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan'));
    expect(e.code).toBe('daily_limit');
    expect(e.message).toMatch(/resets at 00:00 UTC/);
    expect(cloudflareDailyLimitActive()).toBe(true);
  });
});

describe('image format helpers', () => {
  it('detects the real format and the size from the file header', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 0xd0]);
    expect(sniffImageMime(png)).toBe('image/png');
    expect(imageSize(png)).toEqual({ width: 1280, height: 720 });
    // minimal JPEG: SOI, APP0 (length 4), SOF0 with 768x1344
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x40, 0x03, 0x00, 0x03, 0, 0, 0, 0]);
    expect(sniffImageMime(jpg)).toBe('image/jpeg');
    expect(imageSize(jpg)).toEqual({ width: 768, height: 1344 });
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
  it('keeps the source shape when sizing an edit', () => {
    const klein = IMAGE_MODELS[0];
    expect(editSize({ width: 1600, height: 1200 }, klein)).toEqual({ width: 1024, height: 768 });
    expect(editSize({ width: 600, height: 1600 }, klein)).toEqual({ width: 384, height: 1024 });
    expect(editSize(null, klein)).toEqual({ width: 1024, height: 1024 });
  });
});

describe('Cloudflare chat provider', () => {
  const sse = (events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

  it('streams reasoning and text, sums per-chunk usage and Neurons, keeps the token in the header only', async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { choices: [{ delta: { reasoning_content: 'thinking ' } }], usage: { prompt_tokens: 23, completion_tokens: 0, total_tokens: 23, neurons: 0.2 } },
        { choices: [{ delta: { content: 'Hello ' } }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1, neurons: 0.03 } },
        { choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1, neurons: 0.03 } },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const chunks = [];
    for await (const c of new CloudflareProvider().stream({ model: '@cf/google/gemma-4-26b-a4b-it', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(chunks.filter((c) => c.type === 'reasoning').map((c) => (c as { text: string }).text).join('')).toBe('thinking ');
    expect(chunks.filter((c) => c.type === 'delta').map((c) => (c as { text: string }).text).join('')).toBe('Hello there');
    const usage = chunks.find((c) => c.type === 'usage') as { usage: { promptTokens: number; completionTokens: number; neurons: number } };
    expect(usage.usage).toMatchObject({ promptTokens: 23, completionTokens: 2 });
    expect(usage.usage.neurons).toBeCloseTo(0.26, 3);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop', model: '@cf/google/gemma-4-26b-a4b-it' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`);
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it('refuses without credentials and maps HTTP errors', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const p = new CloudflareProvider();
    expect(p.isConfigured()).toBe(false);
    await expect(p.stream({ model: '@cf/x', messages: [] }).next()).rejects.toMatchObject({ code: 'not_configured' });
    process.env.CLOUDFLARE_API_TOKEN = TOKEN;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 401 })));
    await expect(p.stream({ model: '@cf/x', messages: [] }).next()).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('lists only curated models that exist and are not scheduled for deprecation', () => {
    const cfg = { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B', vendor: 'google', blurb: '', vision: true };
    const listing = {
      name: cfg.id,
      properties: [
        { property_id: 'context_window', value: '256000' },
        { property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.1 }, { unit: 'per M output tokens', price: 0.3 }] },
      ],
    };
    const m = mapCloudflareModel(cfg, listing)!;
    expect(m).toMatchObject({ provider: 'cloudflare', contextLength: 256_000, free: true, featured: false, pricing: { prompt: 0.1, completion: 0.3 } });
    expect(m.capabilities.vision).toBe(true);
    expect(mapCloudflareModel(cfg, undefined)).toBeNull();
    expect(mapCloudflareModel(cfg, { ...listing, properties: [...listing.properties, { property_id: 'planned_deprecation_date', value: '2026-11-20' }] })).toBeNull();
  });
});

describe('routing: Cloudflare is manual only', () => {
  const cf = { ...fakeModel('@cf/google/gemma-4-26b-a4b-it', { vision: true }), provider: 'cloudflare', free: true };
  const gemini = { ...fakeModel('gemini:gemini-3.5-flash', { vision: true }), provider: 'gemini', free: true };
  const or = fakeModel('nvidia/nemotron-3-ultra-550b-a55b:free');
  const catalog = [cf, gemini, or];
  const task = detectTask([{ role: 'user', content: 'Hello' }]);

  it('is used when the user selects it, with Gemini/OpenRouter as fallbacks', () => {
    const r = routeModel(cf.id, task, catalog, { paidAvailable: false });
    expect(r.kind === 'ok' && r.chain).toEqual([cf.id, gemini.id, or.id]);
  });
  it('is never picked automatically or used as a fallback', () => {
    for (const selected of [gemini.id, or.id, 'missing/model']) {
      const r = routeModel(selected, task, catalog, { paidAvailable: false, preferredProvider: 'gemini' });
      expect(r.kind === 'ok' && r.chain).not.toContain(cf.id);
    }
    const vision = detectTask([{ role: 'user', content: 'what is this', attachments: [{ kind: 'image', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA' }] }]);
    const r = routeModel(or.id, vision, catalog, { paidAvailable: false });
    expect(r.kind === 'ok' && r.chain).toEqual([gemini.id]);
  });
  it('when an admin makes Cloudflare the preferred provider, it is tried first with Gemini/OpenRouter as fallbacks', () => {
    const r = routeModel('missing/model', task, catalog, { paidAvailable: false, preferredProvider: 'cloudflare' });
    expect(r.kind === 'ok' && r.chain).toEqual([cf.id, gemini.id, or.id]);
    // a model the user chose is still kept
    const kept = routeModel(gemini.id, task, catalog, { paidAvailable: false, preferredProvider: 'cloudflare' });
    expect(kept.kind === 'ok' && kept.chain[0]).toBe(gemini.id);
    // allowance used up (models marked unavailable): replies go to Gemini
    const spent = routeModel(cf.id, task, [{ ...cf, available: false }, gemini, or], { paidAvailable: false, preferredProvider: 'cloudflare' });
    expect(spent.kind === 'ok' && spent.chain[0]).toBe(gemini.id);
    expect(normalizeAiConfig({ preferredProvider: 'cloudflare' }).preferredProvider).toBe('cloudflare');
  });
});

describe('image safety', () => {
  it.each([
    ['a naked woman on a beach', 'sexual'],
    ['a sexy schoolgirl', 'minors'],
    ['a 12 year old girl in a bikini', 'minors'],
    ['a deepfake of the president', 'real_person'],
    ['put my ex\'s face on this body', 'real_person'],
    ['a fake photo of my neighbour stealing', 'real_person'],
    ['a realistic Ghana card with my name and photo', 'fraud'],
    ['counterfeit 100 dollar bills', 'fraud'],
    ['a fake mobile money transfer screenshot', 'fraud'],
    ['the official logo of Ecobank for my website', 'fraud'],
  ])('blocks "%s" (%s) before any model call', (prompt, category) => {
    expect(ruleCheck(prompt)).toBe(category);
  });
  it.each(['a lion in a forest', 'a realistic photograph of Accra at sunset', 'grilled chicken breast on a plate', 'a girl reading a book in a park', 'a professional business logo for a bakery called Sweet Crumbs', 'a military aircraft at dawn'])(
    'allows "%s"',
    (prompt) => expect(ruleCheck(prompt)).toBeNull(),
  );
  it('reads Llama Guard verdicts and fails closed', async () => {
    expect(parseGuardVerdict('safe')).toBeNull();
    expect(parseGuardVerdict('unsafe\nS4')).toBe('minors');
    expect(parseGuardVerdict('unsafe\nS12')).toBe('sexual');
    expect(parseGuardVerdict('unsafe\nS1')).toBe('classifier');
    expect(parseGuardVerdict('I cannot help')).toBe('unparseable');
    expect(await checkImagePrompt('a cat', { guard: async () => ({ text: 'safe', neurons: 9 }) })).toEqual({ ok: true, neurons: 9 });
    expect(await checkImagePrompt('a cat', { guard: async () => ({ text: 'unsafe\nS1', neurons: 9 }) })).toMatchObject({ ok: false, category: 'classifier' });
    expect(await checkImagePrompt('a cat', { guard: async () => Promise.reject(new Error('down')) })).toMatchObject({ ok: false, category: 'unavailable' });
    const guard = vi.fn();
    expect(await checkImagePrompt('nude portrait', { guard })).toMatchObject({ ok: false, category: 'sexual' });
    expect(guard).not.toHaveBeenCalled();
  });
});

describe('image storage', () => {
  it('stores bytes as Firestore bytes values, in chunks under the 1 MiB document limit, outside the metadata', () => {
    const bytes = new Uint8Array(2_100_000).map((_, i) => i % 251);
    expect(splitChunks(bytes).map((c) => c.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 300_000]);
    const enc = encodeValue(bytes.subarray(0, 10));
    expect(enc).toEqual({ bytesValue: Buffer.from(bytes.subarray(0, 10)).toString('base64') });
    expect(decodeValue(enc)).toEqual(bytes.subarray(0, 10));
    const { writes, meta } = imageWrites(
      { id: 'img_1', uid: 'u1', conversationId: 'c1', messageId: 'm1', prompt: 'p', model: 'm', kind: 'generate', sourceImageId: null, mime: 'image/jpeg', width: 1, height: 1 },
      bytes,
    );
    expect(meta).toMatchObject({ chunks: 3, bytes: 2_100_000, storage: 'firestore-chunks', status: 'ready' });
    const metaWrite = writes.at(-1)! as { path: string; data: Record<string, unknown> };
    expect(metaWrite.path).toBe('users/u1/generatedImages/img_1');
    expect(Object.values(metaWrite.data).some((v) => v instanceof Uint8Array)).toBe(false);
    expect(writes.slice(0, 3).map((w) => w.path)).toEqual(['users/u1/generatedImageData/img_1_0', 'users/u1/generatedImageData/img_1_1', 'users/u1/generatedImageData/img_1_2']);
  });
});

/* ------------------------------- full image turns ------------------------------- */

function setup() {
  const db = new FakeDb();
  setAdminDb(db as unknown as Firestore);
  const calls = { image: 0, chat: 0, lastForm: null as FormData | null };
  const fake: CloudflareFake = {
    async image(_model, body) {
      calls.image++;
      calls.lastForm = body.form ?? null;
      const prompt = String(body.form?.get('prompt') ?? body.json?.prompt ?? '');
      if (prompt.includes('FLAGIMAGE')) {
        const { mapCloudflareError } = await import('../server/cloudflare/client.js');
        const body = JSON.stringify({ errors: [{ code: 3030, message: 'AiError: Your output has been flagged. Please choose another prompt / input image combination' }] });
        throw Object.assign(mapCloudflareError(400, body), { neurons: 0 });
      }
      if (prompt.includes('FAILIMAGE')) {
        const { ProviderError } = await import('../server/providers/types.js');
        throw Object.assign(new ProviderError('provider_error', 'Cloudflare Workers AI had a temporary problem.', 502), { neurons: 0 });
      }
      // PNG header with the requested size, padded to ~1.9 MB so it needs 3 chunks
      const w = Number(body.form?.get('width') ?? 1024);
      const h = Number(body.form?.get('height') ?? 1024);
      const bytes = new Uint8Array(1_900_000);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(bytes.buffer).setUint32(16, w);
      new DataView(bytes.buffer).setUint32(20, h);
      return { bytes, mime: 'image/png', neurons: 104.2 };
    },
    async chat(_m, messages) {
      calls.chat++;
      return { text: messages.some((m) => m.content.includes('UNSAFEGUARD')) ? 'unsafe\nS1' : 'safe', neurons: 9 };
    },
  };
  setCloudflareFake(fake);
  return { db, calls };
}

const turn = (db: FakeDb, over: Partial<Parameters<typeof runImageTurn>[0]> = {}) =>
  runImageTurn({
    db: db as unknown as Firestore,
    uid: 'u1',
    conversationId: 'c1',
    messageId: 'm1',
    intent: { kind: 'generate', prompt: 'a lion in a forest' },
    signal: new AbortController().signal,
    onStage: () => undefined,
    ...over,
  });

describe('image turns', () => {
  it('checks safety, generates, stores and counts usage', async () => {
    const { db, calls } = setup();
    const stages: string[] = [];
    const r = await turn(db, { onStage: (s) => stages.push(s), intent: { kind: 'generate', prompt: 'Design a landscape wallpaper' } });
    expect(stages).toEqual(['checking', 'generating', 'saving']);
    expect(calls).toMatchObject({ image: 1, chat: 1 });
    expect(calls.lastForm?.get('width')).toBe('1344');
    expect(calls.lastForm?.get('height')).toBe('768');
    expect(r).toMatchObject({ stored: true, reused: false });
    expect(r.meta).toMatchObject({ id: imageIdFor('m1'), uid: 'u1', conversationId: 'c1', model: imageModel().id, mime: 'image/png', width: 1344, height: 768, chunks: 3, status: 'ready' });
    const loaded = await loadImage(db as unknown as Firestore, 'u1', r.meta.id);
    expect(loaded?.bytes).toEqual(r.bytes);
    const day = db.docs.get(usagePath(utcDay()))!;
    expect(day.neurons).toBeCloseTo(113.2, 3);
    const user = db.docs.get(`users/u1/usage/${utcDay()}`)!;
    expect(user['images.generated']).toBe(1);
  });

  it('a retried reply reuses the stored image: no second generation, no duplicate', async () => {
    const { db, calls } = setup();
    await turn(db);
    resetBudgetState(); // the retry comes later
    const again = await turn(db);
    expect(again.reused).toBe(true);
    expect(calls.image).toBe(1);
    expect([...db.docs.keys()].filter((k) => k.startsWith('users/u1/generatedImages/'))).toHaveLength(1);
  });

  it('keeps the image for download when storing fails', async () => {
    const { db } = setup();
    db.denyPrefix = ['users/u1/generatedImageData'];
    const r = await turn(db);
    expect(r.stored).toBe(false);
    expect(r.bytes.length).toBe(1_900_000);
    expect(db.docs.has(metaPath('u1', r.meta.id))).toBe(false);
  });

  it('refuses unsafe prompts without calling the image model', async () => {
    const { db, calls } = setup();
    await expect(turn(db, { intent: { kind: 'generate', prompt: 'a nude portrait' } })).rejects.toMatchObject({ code: 'image_blocked' });
    resetBudgetState();
    await expect(turn(db, { messageId: 'm2', intent: { kind: 'generate', prompt: 'UNSAFEGUARD scene' } })).rejects.toBeInstanceOf(ImageError);
    expect(calls.image).toBe(0);
  });

  it('stops at the app-wide free allowance cap and never calls Cloudflare beyond it', async () => {
    const { db, calls } = setup();
    db.docs.set(usagePath(utcDay()), { neurons: 8950 });
    await expect(turn(db)).rejects.toMatchObject({ code: 'image_allowance' });
    expect(calls).toMatchObject({ image: 0, chat: 0 });
  });

  it('enforces the per-user daily limit and one request at a time', async () => {
    const { db } = setup();
    db.docs.set(`users/u1/usage/${utcDay()}`, { images: { generated: 10 } });
    await expect(turn(db)).rejects.toMatchObject({ code: 'image_daily_limit' });
    db.docs.delete(`users/u1/usage/${utcDay()}`);
    resetBudgetState();
    const slot = await claimUserSlot(db as unknown as Firestore, 'u1');
    expect(slot.ok).toBe(true);
    expect(await claimUserSlot(db as unknown as Firestore, 'u1')).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('edits the previous image: sends it as input, saves the result as a separate image', async () => {
    const { db, calls } = setup();
    const first = await turn(db);
    resetBudgetState();
    const edit = await turn(db, { messageId: 'm2', intent: { kind: 'edit', prompt: 'make it more realistic', source: 'previous' }, previousImageId: first.meta.id });
    expect(calls.lastForm?.get('input_image_0')).toBeInstanceOf(Blob);
    expect(edit.meta).toMatchObject({ kind: 'edit', sourceImageId: first.meta.id, id: imageIdFor('m2') });
    expect(db.docs.has(metaPath('u1', first.meta.id))).toBe(true); // original kept
    expect(db.docs.has(metaPath('u1', edit.meta.id))).toBe(true);
  });

  it('records a failed generation and surfaces a retryable provider error', async () => {
    const { db } = setup();
    await expect(turn(db, { intent: { kind: 'generate', prompt: 'FAILIMAGE a cat' } })).rejects.toMatchObject({ code: 'provider_error' });
    const day = db.docs.get(usagePath(utcDay()))!;
    expect(day['types.image_generate.failed']).toBe(1);
  });

  it("explains the image model's own output filter as a refusal with advice, not a retryable error", async () => {
    const { db, calls } = setup();
    const err = await turn(db, { intent: { kind: 'generate', prompt: 'FLAGIMAGE a Tesla car' } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'image_flagged', retryable: false });
    expect(err.message).toMatch(/own safety filter/);
    expect(err.message).not.toMatch(/AiError|choose another prompt/);
    expect(err.suggestion).toMatch(/without the brand/);
    expect(calls.image).toBe(1);
    const day = db.docs.get(usagePath(utcDay()))!;
    expect(day['types.image_generate.failed']).toBe(1);
  });

  it('reservations count in-flight calls against the cap', async () => {
    const db = new FakeDb();
    setAdminDb(db as unknown as Firestore);
    db.docs.set(usagePath(utcDay()), { neurons: 8800 });
    const a = await reserveNeurons(db as unknown as Firestore, 150);
    expect(a.ok).toBe(true);
    const b = await reserveNeurons(db as unknown as Firestore, 150);
    expect(b).toMatchObject({ ok: false, reason: 'app_cap' });
    if (a.ok) await a.settle(104, { uid: 'u1', model: 'x', type: 'text', ok: true });
    await recordUsage(db as unknown as Firestore, 0, { uid: 'u1', model: 'x', type: 'safety', ok: false, error: 'aborted' });
    expect(db.docs.get(usagePath(utcDay()))!.neurons).toBe(8904);
  });
});
