import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminDb } from '../server/admin.js';
import { resetBudgetState, usagePath, utcDay } from '../server/cloudflare/budget.js';
import { resetCloudflareDailyLimit } from '../server/cloudflare/client.js';
import { detectTurnEnd, setSpeechFake, speak, transcribe, translateText, type SpeechFake } from '../server/cloudflare/speech.js';
import { TRANSLATE_CODES, TTS_USER_DAILY_NEURONS } from '../server/config/speech.js';
import { invalidateLimits } from '../server/config/limits.js';
import type { Firestore } from '../server/firestore.js';
import { detectLanguage, mapLimit, planTranslation, requestedTarget } from '../server/speech/translate.js';
import { FakeDb } from './fakeDb.js';

const db = { current: new FakeDb() };
vi.mock('../server/access.js', () => ({
  requireAllowedUser: async () => ({ user: { uid: 'u1', email: 'a@b.c' }, db: db.current, admin: false }),
}));
const api = await import('../api/speech.js');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-should-never-leak';

const calls = { transcribe: 0, speak: 0, translate: [] as string[] };
const fake: SpeechFake = {
  async transcribe(audio) {
    calls.transcribe++;
    return { text: 'bonjour tout le monde', language: 'fr', duration: audio.byteLength / 1000, neurons: 2.6 };
  },
  async speak(text) {
    calls.speak++;
    return { bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(100).fill(0)]), neurons: text.length * 1.3637 };
  },
  async translate(text, _source, target) {
    calls.translate.push(text);
    return { text: `<${target}>${text}`, neurons: 1.5 };
  },
};

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  resetCloudflareDailyLimit();
  resetBudgetState();
  invalidateLimits();
  db.current = new FakeDb();
  setAdminDb(db.current as unknown as Firestore);
  calls.transcribe = 0;
  calls.speak = 0;
  calls.translate = [];
  setSpeechFake(fake);
});
afterEach(() => {
  setSpeechFake(null);
  setAdminDb(null);
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

const post = (body: unknown, query = '', headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  api.POST(new Request(`http://localhost/api/speech${query}`, { method: 'POST', headers: { authorization: 'Bearer x', ...headers }, body: body as BodyInit }));

/* --------------------------------- formatting --------------------------------- */

describe('planTranslation keeps the shape of the text', () => {
  const run = (md: string) => {
    const pieces = planTranslation(md);
    return { sent: pieces.filter((p) => p.text).map((p) => p.text), out: pieces.map((p) => p.render(p.text ? `T(${p.text})` : '')).join('') };
  };
  it('keeps headings, list markers, quotes and line breaks; translates only the words', () => {
    const { sent, out } = run('# Title\n\n- first item\n1. second item\n> a quote\nPlain line.');
    expect(sent).toEqual(['Title', 'first item', 'second item', 'a quote', 'Plain line.']);
    expect(out).toBe('# T(Title)\n\n- T(first item)\n1. T(second item)\n> T(a quote)\nT(Plain line.)');
  });
  it('never sends code blocks, URLs or symbol-only lines', () => {
    const { sent, out } = run('Intro\n```js\nconst a = 1;\n```\nhttps://example.com/x\n---\n42');
    expect(sent).toEqual(['Intro']);
    expect(out).toBe('T(Intro)\n```js\nconst a = 1;\n```\nhttps://example.com/x\n---\n42');
  });
  it('translates table cells one by one and keeps pipes and the alignment row', () => {
    const { sent, out } = run('| Name | Age |\n|---|---|\n| Ama | 30 |');
    expect(sent).toEqual(['Name', 'Age', 'Ama']);
    expect(out).toBe('| T(Name) | T(Age) |\n|---|---|\n| T(Ama) | 30 |');
  });
  it('splits a very long paragraph at sentence ends', () => {
    const para = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i}.`).join(' ');
    const { sent } = run(para);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((s) => s.length <= 900)).toBe(true);
    expect(sent.join(' ').replace(/\s+/g, ' ')).toBe(para);
  });
});

describe('language detection (free, no model call)', () => {
  it('recognises scripts and common words', () => {
    expect(detectLanguage('こんにちは、元気ですか')).toBe('japanese');
    expect(detectLanguage('안녕하세요 반갑습니다')).toBe('korean');
    expect(detectLanguage('你好，今天天气很好')).toBe('chinese');
    expect(detectLanguage('مرحبا كيف حالك اليوم')).toBe('arabic');
    expect(detectLanguage('Привет, как у тебя дела?')).toBe('russian');
    expect(detectLanguage('नमस्ते आप कैसे हैं')).toBe('hindi');
    expect(detectLanguage('What is the weather like in the city today and how are you?')).toBe('english');
    expect(detectLanguage('Bonjour, je suis content de vous voir avec les enfants.')).toBe('french');
    expect(detectLanguage('Hola, ¿cómo está? Es muy bueno para los niños y las niñas.')).toBe('spanish');
    expect(detectLanguage('Hallo, ich bin nicht sicher, wie das ist und was die Zeit ist.')).toBe('german');
  });
  it('returns null when unsure instead of guessing', () => {
    expect(detectLanguage('OK')).toBeNull();
    expect(detectLanguage('12345 !!!')).toBeNull();
  });
  it('reads an explicit target language', () => {
    expect(requestedTarget('translate this to French please')).toBe('french');
    expect(requestedTarget('say hello in Swahili')).toBe('swahili');
    expect(requestedTarget('translate this to Klingon')).toBeNull();
  });
  it('every detectable language is one that is offered', () => {
    for (const s of ['こんにちは', '안녕하세요 반갑습니다', '你好你好你好']) {
      const l = detectLanguage(s);
      if (l) expect(TRANSLATE_CODES.has(l)).toBe(true);
    }
  });
  it('mapLimit keeps order and limits concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });
});

/* ------------------------------- Cloudflare calls ------------------------------- */

describe('speech client (real request format, mocked network)', () => {
  beforeEach(() => setSpeechFake(null));
  const ok = (body: BodyInit, type: string, neurons = '2.6') => new Response(body, { status: 200, headers: { 'content-type': type, 'cf-ai-neurons': neurons } });

  it('sends Whisper base64 audio and reads text, language and duration', async () => {
    const fetchMock = vi.fn(async () => ok(JSON.stringify({ result: { text: ' hello ', transcription_info: { language: 'en', duration: 3.3 } } }), 'application/json'));
    vi.stubGlobal('fetch', fetchMock);
    const t = await transcribe(new Uint8Array([1, 2, 3]));
    expect(t).toEqual({ text: 'hello', language: 'en', duration: 3.3, neurons: 2.6 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/accounts/${ACCOUNT}/ai/run/@cf/openai/whisper-large-v3-turbo`);
    expect(JSON.parse(String(init.body))).toEqual({ audio: 'AQID' });
  });
  it('rejects a voice response that is not audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok('{"error":"x"}', 'application/json', '1')));
    await expect(speak('hi')).rejects.toMatchObject({ code: 'provider_error' });
  });
  it('asks Smart Turn with float32 PCM and reads its verdict', async () => {
    const fetchMock = vi.fn(async () => ok(JSON.stringify({ result: { is_complete: false, probability: 0.04 } }), 'application/json', '0'));
    vi.stubGlobal('fetch', fetchMock);
    const v = await detectTurnEnd(new Float32Array([0.5, -0.25]));
    expect(v).toEqual({ complete: false, probability: 0.04, neurons: 0 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/ai/run/@cf/pipecat-ai/smart-turn-v2');
    const body = JSON.parse(String(init.body));
    expect(body.dtype).toBe('float32');
    expect(Array.from(new Float32Array(Uint8Array.from(Buffer.from(body.audio, 'base64')).buffer))).toEqual([0.5, -0.25]);
  });
  it('maps the used-up free allocation to daily_limit without leaking the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 4006, message: `daily free allocation used ${TOKEN}` }] }), { status: 429 })));
    const err = await translateText('hi', 'english', 'french').catch((e) => e);
    expect(err.code).toBe('daily_limit');
    expect(String(err.message)).not.toContain(TOKEN);
  });
});

/* ---------------------------------- /api/speech ---------------------------------- */

describe('/api/speech', () => {
  it('GET lists only the offered languages and the natural-voice share', async () => {
    const res = await api.GET(new Request('http://localhost/api/speech', { headers: { authorization: 'Bearer x' } }));
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.languages.map((l: { code: string }) => l.code)).toEqual([...TRANSLATE_CODES]);
    expect(body.naturalVoice.available).toBe(true);
  });

  it('transcribes a recording and counts its exact cost', async () => {
    const res = await post(new Uint8Array(3000), '?action=transcribe', { 'content-type': 'audio/webm;codecs=opus' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'bonjour tout le monde', language: 'french', duration: 3 });
    const day = db.current.docs.get(usagePath(utcDay()))!;
    expect(day.neurons).toBeCloseTo(2.6, 3);
    expect(db.current.docs.get(`users/u1/usage/${utcDay()}`)!['voice.stt.requests']).toBe(1);
  });

  it('end-of-turn check: converts 16-bit PCM, answers with the verdict and counts the request', async () => {
    let got: Float32Array | null = null;
    setSpeechFake({ ...fake, turn: async (pcm) => ((got = pcm), { complete: true, probability: 0.93, neurons: 0.01 }) });
    const pcm = new Int16Array(16_000).fill(16384);
    const res = await post(new Uint8Array(pcm.buffer), '?action=turn', { 'content-type': 'application/octet-stream' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ complete: true, probability: 0.93 });
    expect(got!.length).toBe(16_000);
    expect(got![0]).toBeCloseTo(0.5, 5);
    expect(db.current.docs.get(`users/u1/usage/${utcDay()}`)!['voice.turn.requests']).toBe(1);
  });

  it('end-of-turn check stays inside the free daily Neuron allowance (no request once it is used up)', async () => {
    let called = 0;
    setSpeechFake({ ...fake, turn: async () => (called++, { complete: true, probability: 0.9, neurons: 0.01 }) });
    db.current.docs.set(usagePath(utcDay()), { neurons: 9_000 });
    const pcm = new Int16Array(16_000).fill(16384);
    const res = await post(new Uint8Array(pcm.buffer), '?action=turn', { 'content-type': 'application/octet-stream' });
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toMatch(/never switches to paid/);
    expect(called).toBe(0);
  });

  it('end-of-turn check refuses too little or too much audio', async () => {
    expect((await post(new Uint8Array(100), '?action=turn', { 'content-type': 'application/octet-stream' })).status).toBe(400);
    expect((await post(new Uint8Array(16_000 * 2 * 9), '?action=turn', { 'content-type': 'application/octet-stream' })).status).toBe(400);
  });

  it('refuses unsupported, empty and oversized audio before calling the model', async () => {
    expect((await post(new Uint8Array(3000), '?action=transcribe', { 'content-type': 'video/mp4' })).status).toBe(415);
    expect((await post(new Uint8Array(50), '?action=transcribe', { 'content-type': 'audio/wav' })).status).toBe(400);
    expect((await post(new Uint8Array(4_100_000), '?action=transcribe', { 'content-type': 'audio/wav' })).status).toBe(413);
    expect(calls.transcribe).toBe(0);
  });

  it('speaks in the natural voice and returns MP3', async () => {
    const res = await post(JSON.stringify({ action: 'speak', text: 'Hello there, how are you today?' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0xff);
  });

  it('stops the natural voice at a person’s daily share (the device voice takes over)', async () => {
    const text = 'x'.repeat(400);
    let status = 200;
    for (let i = 0; i < 10 && status === 200; i++) {
      resetBudgetState();
      status = (await post(JSON.stringify({ action: 'speak', text }))).status;
    }
    expect(status).toBe(429);
    expect(calls.speak).toBeLessThanOrEqual(Math.floor(TTS_USER_DAILY_NEURONS / (400 * 1.3637)));
  });

  it('translates, keeping the formatting, and detects the source language', async () => {
    const res = await post(JSON.stringify({ action: 'translate', text: '# Bonjour\n\nJe suis content de vous voir avec les enfants.\n```\ncode\n```', target: 'english' }));
    const body = await res.json();
    expect(body.source).toBe('french');
    expect(body.text).toBe('# <english>Bonjour\n\n<english>Je suis content de vous voir avec les enfants.\n```\ncode\n```');
    expect(calls.translate).toHaveLength(2);
  });

  it('reports languages that are not offered and text whose language is unclear', async () => {
    const r1 = await post(JSON.stringify({ action: 'translate', text: 'hello', target: 'klingon' }));
    expect(r1.status).toBe(400);
    expect((await r1.json()).error ?? '').toBeDefined();
    const r2 = await post(JSON.stringify({ action: 'translate', text: 'OK', target: 'french' }));
    expect(r2.status).toBe(422);
    expect(calls.translate).toHaveLength(0);
  });

  it('pauses with a clear message when the free allowance is used up, never switching to paid', async () => {
    setSpeechFake({
      ...fake,
      async translate() {
        const { mapCloudflareError } = await import('../server/cloudflare/client.js');
        throw mapCloudflareError(429, JSON.stringify({ errors: [{ code: 4006, message: 'used up your daily free allocation' }] }));
      },
    });
    const res = await post(JSON.stringify({ action: 'translate', text: 'Hello there', source: 'english', target: 'french' }));
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toMatch(/never switches to paid/);
  });

  it('is unavailable (not broken) when Cloudflare is not configured', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const res = await post(JSON.stringify({ action: 'speak', text: 'hi' }));
    expect(res.status).toBe(503);
  });
});
