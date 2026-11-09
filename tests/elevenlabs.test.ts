import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminDb } from '../server/admin.js';
import { resetBudgetState } from '../server/cloudflare/budget.js';
import { ELEVEN_MAXIMA, normalizeElevenSettings } from '../server/config/elevenlabs.js';
import { setElevenLabsFetch } from '../server/elevenlabs/client.js';
import { resetElevenRoutes } from '../server/elevenlabs/routes.js';
import { resetElevenState } from '../server/elevenlabs/usage.js';
import type { Firestore } from '../server/firestore.js';
import { FakeDb } from './fakeDb.js';

const db = { current: new FakeDb() };
const who = { admin: false };
vi.mock('../server/access.js', () => ({
  requireAllowedUser: async () => ({ user: { uid: 'u1', email: 'a@b.c' }, db: db.current, admin: who.admin }),
}));
const api = await import('../api/speech.js');

const KEY = 'sk_test_elevenlabs_key_should_never_leak';
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(200).fill(1)]);

interface Call {
  url: string;
  method: string;
  key: string | null;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
let reply: (c: Call) => Response;

const audioReply = (credits = 19) => () =>
  new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg', 'character-cost': String(credits), 'request-id': 'req123' } });

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  let body: Record<string, unknown> | null;
  try {
    body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  const c = { url, method: init?.method ?? 'GET', key: headers.get('xi-api-key'), body };
  calls.push(c);
  return Promise.resolve(reply(c));
}

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = KEY;
  db.current = new FakeDb();
  setAdminDb(db.current as unknown as Firestore);
  resetElevenState();
  resetElevenRoutes();
  resetBudgetState();
  who.admin = false;
  calls = [];
  reply = audioReply();
  setElevenLabsFetch(fakeFetch as typeof fetch);
});
afterEach(() => {
  setElevenLabsFetch(null);
  setAdminDb(null);
  delete process.env.ELEVENLABS_API_KEY;
});

const post = (body: unknown) =>
  api.POST(new Request('http://localhost/api/speech', { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const get = () => api.GET(new Request('http://localhost/api/speech', { headers: { authorization: 'Bearer x' } }));

async function enable(patch: Record<string, unknown> = {}) {
  who.admin = true;
  const r = await post({ action: 'elevenAdmin', op: 'settings', settings: { enabled: true, ...patch } });
  expect(r.status).toBe(200);
  who.admin = false;
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('ElevenLabs settings', () => {
  it('are off by default and clamp every number', () => {
    expect(normalizeElevenSettings(null).enabled).toBe(false);
    const s = normalizeElevenSettings({ enabled: true, appDailyCredits: 1e12, userDailyCredits: -5, defaultModel: 'made_up' });
    expect(s.appDailyCredits).toBe(ELEVEN_MAXIMA.appDailyCredits);
    expect(s.userDailyCredits).toBe(0);
    expect(s.defaultModel).toBe('eleven_flash_v2_5');
  });
});

describe('/api/speech with ElevenLabs', () => {
  it('GET reports ElevenLabs as configured but off, without the key and without voices', async () => {
    const res = await get();
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body.elevenlabs).toMatchObject({ configured: true, enabled: false, available: false, voices: [] });
    expect(calls).toHaveLength(0);
  });

  it('GET reports not configured when the server has no key', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    setElevenLabsFetch(null);
    const body = await (await get()).json();
    expect(body.elevenlabs).toEqual({ configured: false });
  });

  it('refuses to speak while an administrator has not enabled it (no request to ElevenLabs)', async () => {
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'Hello there' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('eleven_disabled');
    expect(calls).toHaveLength(0);
  });

  it('only administrators can change settings or design voices', async () => {
    for (const body of [
      { action: 'elevenAdmin', op: 'settings', settings: { enabled: true } },
      { action: 'elevenAdmin', op: 'status' },
      { action: 'elevenAdmin', op: 'design', description: 'A calm and friendly narrator voice', text: 'x'.repeat(120) },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('streams speech with the real request format, server-side key, and records the reported credits', async () => {
    await enable();
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'Hello, I am Atlas.', voiceId: 'EXAVITQu4vr4xnSDxMaL', speed: 1.1, previousText: 'Before.' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toContain('https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/stream');
    expect(c.url).toContain('output_format=mp3_44100_64');
    expect(c.key).toBe(KEY);
    expect(c.body).toMatchObject({ text: 'Hello, I am Atlas.', model_id: 'eleven_flash_v2_5', previous_text: 'Before.', voice_settings: { speed: 1.1 } });
    await flush();
    const day = new Date().toISOString().slice(0, 10);
    const usage = db.current.docs.get(`elevenlabsUsage/${day}`)!;
    expect(usage.credits).toBe(19);
    expect(usage.characters).toBe(18);
    expect(db.current.docs.get(`users/u1/usage/${day}`)!['providers.elevenlabs.credits']).toBe(19);
    const history = [...db.current.docs.entries()].filter(([p]) => p.startsWith('elevenlabsRequests/')).map(([, d]) => d);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ uid: 'u1', type: 'tts', model: 'eleven_flash_v2_5', voiceId: 'EXAVITQu4vr4xnSDxMaL', characters: 18, credits: 19, ok: true, requestId: 'req123' });
    expect(JSON.stringify(history[0])).not.toContain('Atlas');
  });

  it('works when Cloudflare is not configured (separate provider)', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    await enable();
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'Hi' });
    expect(res.status).toBe(200);
  });

  it('only speaks with voices Atlas AI offers', async () => {
    await enable();
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'Hello', voiceId: 'SomeoneElsesVoice123' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('stops at the per-person daily cap before calling ElevenLabs', async () => {
    await enable({ userDailyCredits: 30 });
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'x'.repeat(100) }); // ~50 credits on Flash
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('eleven_user_daily');
    expect(calls).toHaveLength(0);
  });

  it('stops at the app-wide daily and monthly caps', async () => {
    await enable({ appDailyCredits: 40 });
    reply = audioReply(30);
    expect((await post({ action: 'speak', provider: 'elevenlabs', text: 'x'.repeat(60) })).status).toBe(200);
    await flush();
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'x'.repeat(60) });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('eleven_app_daily');
    expect(calls).toHaveLength(1);

    resetElevenState();
    await enable({ appDailyCredits: 10_000, appMonthlyCredits: 35 });
    const m = await post({ action: 'speak', provider: 'elevenlabs', text: 'x'.repeat(60) });
    expect((await m.json()).error.code).toBe('eleven_app_monthly');
  });

  it('maps a missing key permission to a clear message, never leaking the key or provider text', async () => {
    await enable();
    reply = () =>
      new Response(JSON.stringify({ detail: { type: 'authentication_error', code: 'unauthorized', message: `missing the permission text_to_speech ${KEY}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const res = await post({ action: 'speak', provider: 'elevenlabs', text: 'Hello' });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('text_to_speech');
    expect(JSON.parse(text).error.code).toBe('eleven_model_unavailable');
    await flush();
    const day = new Date().toISOString().slice(0, 10);
    expect(db.current.docs.get(`elevenlabsUsage/${day}`)).toMatchObject({ credits: 0, failed: 1 });
  });

  it('a voice preview speaks the fixed sample sentence', async () => {
    await enable();
    const res = await post({ action: 'speak', provider: 'elevenlabs', preview: true, voiceId: 'JBFqnCBsd6RMkjVDRZzb' });
    expect(res.status).toBe(200);
    expect(String(calls[0].body?.text)).toMatch(/^Hello, I’m Atlas/);
  });

  it('GET lists voices and the credits left once enabled', async () => {
    await enable({ userDailyCredits: 300 });
    const body = await (await get()).json();
    expect(body.elevenlabs.enabled).toBe(true);
    expect(body.elevenlabs.creditsLeft).toBe(300);
    expect(body.elevenlabs.charactersLeft).toBe(600);
    expect(body.elevenlabs.voices.length).toBeGreaterThanOrEqual(8);
  });
});

describe('Voice Design (administrators)', () => {
  const description = 'A calm, warm narrator with a gentle pace';
  const text = 'Welcome to Atlas AI. I can help you write, plan, research and learn, and I will always tell you when I am not sure about something.';

  it('designs previews, needs the consent statement to save, then offers the saved voice', async () => {
    await enable();
    who.admin = true;
    reply = (c) =>
      c.url.includes('/v1/text-to-voice/design')
        ? new Response(JSON.stringify({ previews: [{ audio_base_64: 'AAAA', generated_voice_id: 'gen123456', media_type: 'audio/mpeg', duration_secs: 4.2, language: 'en' }], text }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'character-cost': '130' },
          })
        : new Response(JSON.stringify({ voice_id: 'NewVoice12345678', name: 'Calm' }), { status: 200, headers: { 'content-type': 'application/json' } });

    const d = await post({ action: 'elevenAdmin', op: 'design', description, text });
    expect(d.status).toBe(200);
    const out = await d.json();
    expect(out.previews[0]).toMatchObject({ generatedVoiceId: 'gen123456', durationSecs: 4.2 });
    expect(out.credits).toBe(130);
    const designCall = calls.find((c) => c.url.includes('/v1/text-to-voice/design'))!;
    expect(designCall.body).toMatchObject({ voice_description: description, model_id: 'eleven_multilingual_ttv_v2', text });
    expect(designCall.body).not.toHaveProperty('reference_audio_base64');

    const noConsent = await post({ action: 'elevenAdmin', op: 'save', generatedVoiceId: 'gen123456', name: 'Calm', description });
    expect(noConsent.status).toBe(400);

    const saved = await post({ action: 'elevenAdmin', op: 'save', generatedVoiceId: 'gen123456', name: 'Calm', description, consent: true });
    expect(saved.status).toBe(200);
    const doc = db.current.docs.get('elevenlabsVoices/NewVoice12345678')!;
    expect(doc).toMatchObject({ name: 'Calm', createdBy: 'a@b.c' });
    expect((doc.consent as { statement: string }).statement).toMatch(/not a copy of a real person/);

    who.admin = false;
    reply = audioReply();
    const speak = await post({ action: 'speak', provider: 'elevenlabs', text: 'Hi', voiceId: 'NewVoice12345678' });
    expect(speak.status).toBe(200);
  });

  it('refuses a design without a valid sample text (no request, no credits)', async () => {
    await enable();
    who.admin = true;
    const res = await post({ action: 'elevenAdmin', op: 'design', description, text: 'too short' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('removing a voice hides it even when the key cannot delete voices', async () => {
    await enable();
    who.admin = true;
    await db.current.set('elevenlabsVoices/NewVoice12345678', { name: 'Calm', description, createdAt: 1, createdBy: 'a@b.c' });
    reply = () => new Response(JSON.stringify({ detail: { code: 'unauthorized' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    const res = await post({ action: 'elevenAdmin', op: 'remove', voiceId: 'NewVoice12345678' });
    expect(await res.json()).toEqual({ deletedAtElevenLabs: false });
    who.admin = false;
    reply = audioReply();
    expect((await post({ action: 'speak', provider: 'elevenlabs', text: 'Hi', voiceId: 'NewVoice12345678' })).status).toBe(400);
  });

  it('status shows settings, usage, history and capabilities without the key', async () => {
    await enable();
    who.admin = true;
    const res = await post({ action: 'elevenAdmin', op: 'status' });
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const s = JSON.parse(text);
    expect(s.settings.enabled).toBe(true);
    expect(s.capabilities.find((c: { id: string }) => c.id === 'image_video').status).toBe('needs_plan');
  });
});

describe('ElevenLabs concurrency', () => {
  it('limits running requests per person and frees a slot when a stream ends or is cancelled', async () => {
    await enable();
    const open = [];
    for (let i = 0; i < 3; i++) open.push(await post({ action: 'speak', provider: 'elevenlabs', text: `Part ${i}` }));
    const busy = await post({ action: 'speak', provider: 'elevenlabs', text: 'Part 4' });
    expect(busy.status).toBe(429);
    expect((await busy.json()).error.code).toBe('eleven_busy');
    await open[0].arrayBuffer();
    await open[1].body!.cancel();
    expect((await post({ action: 'speak', provider: 'elevenlabs', text: 'Part 5' })).status).toBe(200);
  });
});

describe('ElevenLabs plan limits', () => {
  it('reports "needs a paid plan" for the real Voice Design refusal on a free plan (no credits recorded)', async () => {
    await enable();
    who.admin = true;
    reply = () =>
      new Response(
        JSON.stringify({ detail: { type: 'authorization_error', code: 'feature_not_available', status: 'feature_unavailable', message: 'Creating a voice through the API is only available on a paid plan.' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    const text = 'Hello, I am Atlas. I can help you write, plan, research and learn. Ask me anything and I will explain it clearly.';
    const res = await post({ action: 'elevenAdmin', op: 'design', description: 'A warm, calm adult woman with a gentle accent', text });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.message).toMatch(/paid plan/);
    await flush();
    const day = new Date().toISOString().slice(0, 10);
    expect(db.current.docs.get(`elevenlabsUsage/${day}`)).toMatchObject({ credits: 0, failed: 1 });
  });
});

describe('ElevenLabs capability detection (turns paid features on by itself)', () => {
  const sample = 'Hello, I am Atlas. I can help you write, plan, research and learn. Ask me anything and I will explain it clearly.';
  const designBody = { action: 'elevenAdmin', op: 'design', description: 'A warm, calm adult woman with a gentle accent', text: sample };
  const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const noPermission = () => jsonRes({ detail: { status: 'missing_permissions', code: 'unauthorized', message: 'The API key is missing the permission x' } }, 401);
  const planRefusal = () => jsonRes({ detail: { type: 'authorization_error', code: 'feature_not_available', status: 'feature_unavailable', message: 'paid plan' } }, 403);
  const preview = () =>
    new Response(JSON.stringify({ previews: [{ audio_base_64: 'AAAA', generated_voice_id: 'gen123456', media_type: 'audio/mpeg', duration_secs: 4.2, language: 'en' }], text: sample }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'character-cost': '120' },
    });
  const subscription = (tier: string) =>
    jsonRes({ tier, character_count: 1200, character_limit: tier === 'free' ? 10000 : 100000, next_character_count_reset_unix: 1_800_000_000, status: 'active' });
  /** an account whose key may (or may not) read the plan */
  const account = (tier: string | null, design: () => Response) => (c: Call) =>
    c.url.includes('/v1/user/subscription') ? (tier ? subscription(tier) : noPermission()) : c.url.includes('/voices?') ? noPermission() : c.url.includes('/v1/text-to-voice/design') ? design() : audioReply()();
  const status = async (op = 'status') => (await (await post({ action: 'elevenAdmin', op })).json()) as { capabilities: { id: string; status: string; note?: string }[]; plan: { tier: string } | null };
  const cap = (s: Awaited<ReturnType<typeof status>>, id: string) => s.capabilities.find((c) => c.id === id)!;
  const designCalls = () => calls.filter((c) => c.url.includes('/v1/text-to-voice/design')).length;

  it('without user_read: shows the missing permissions and lets the first Voice Design attempt find out', async () => {
    await enable();
    who.admin = true;
    reply = account(null, planRefusal);
    const s = await status();
    expect(s.plan).toBeNull();
    expect(cap(s, 'subscription').status).toBe('missing_permission');
    expect(cap(s, 'voice_list').status).toBe('missing_permission');
    expect(cap(s, 'voice_design').status).toBe('unknown');
    expect(JSON.stringify(s)).not.toContain('The API key is missing'); // never the provider's text
  });

  it('remembers a plan refusal (no repeat requests), and "Check again" after upgrading turns Voice Design on', async () => {
    await enable();
    who.admin = true;
    reply = account(null, planRefusal);
    expect((await post(designBody)).status).toBe(402);
    expect(designCalls()).toBe(1);
    expect(cap(await status(), 'voice_design').status).toBe('needs_plan');
    // blocked locally while the refusal is fresh: nothing is sent to ElevenLabs
    const again = await post(designBody);
    expect(again.status).toBe(402);
    expect((await again.json()).error.code).toBe('eleven_needs_plan');
    expect(designCalls()).toBe(1);
    // the administrator upgrades, then presses Check again
    reply = account(null, preview);
    expect(cap(await status('refresh'), 'voice_design').status).toBe('unknown');
    expect((await post(designBody)).status).toBe(200);
    expect(cap(await status(), 'voice_design').status).toBe('available');
  });

  it('with user_read: a free plan blocks Voice Design up front, and an upgrade unlocks it automatically', async () => {
    await enable();
    who.admin = true;
    reply = account('free', preview);
    let s = await status();
    expect(s.plan?.tier).toBe('free');
    expect(cap(s, 'subscription').status).toBe('available');
    expect(cap(s, 'voice_design').status).toBe('needs_plan');
    expect((await post(designBody)).status).toBe(402);
    expect(designCalls()).toBe(0);

    reply = account('creator', preview);
    s = await status('refresh');
    expect(s.plan?.tier).toBe('creator');
    expect(cap(s, 'voice_design').status).toBe('available');
    expect(cap(s, 'image_video').status).toBe('needs_plan');
    expect((await post(designBody)).status).toBe(200);
  });

  it('a Pro plan reports image and video as included but not built (never pretends)', async () => {
    who.admin = true;
    reply = account('pro', preview);
    const s = await status('refresh');
    expect(cap(s, 'image_video').status).toBe('not_built');
    expect(cap(s, 'speech_engine').status).toBe('needs_hosting');
  });

  it('re-checks on its own after an hour, without "Check again"', async () => {
    who.admin = true;
    reply = account('free', preview);
    expect(cap(await status(), 'voice_design').status).toBe('needs_plan');
    reply = account('creator', preview);
    expect(cap(await status(), 'voice_design').status).toBe('needs_plan'); // cached
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    try {
      expect(cap(await status(), 'voice_design').status).toBe('available');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the previous answer when ElevenLabs cannot be reached', async () => {
    who.admin = true;
    reply = account('creator', preview);
    await status();
    reply = () => jsonRes({ detail: 'down' }, 500);
    const s = await status('refresh');
    expect(s.plan?.tier).toBe('creator');
    expect(cap(s, 'voice_design').status).toBe('available');
  });
});
