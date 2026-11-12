/**
 * Multi-account routing for Gemini (projects A/B) and Cloudflare (accounts A/B).
 * Every provider call is a mocked fetch: no quota is used and no request leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminDb } from '../server/admin.js';
import { accountNeurons, reserveNeurons, resetBudgetState, usagePath, utcDay } from '../server/cloudflare/budget.js';
import { aiBase, cloudflareDailyLimitActive, mapCloudflareError, resetCloudflareDailyLimit } from '../server/cloudflare/client.js';
import { invalidateLimits } from '../server/config/limits.js';
import { nextPacificMidnight, pacificDay } from '../server/config/providerLimits.js';
import type { Firestore } from '../server/firestore.js';
import * as H from '../server/providers/accountHealth.js';
import { CloudflareProvider } from '../server/providers/cloudflare.js';
import { GeminiProvider } from '../server/providers/gemini.js';
import { geminiAccounts, geminiUsagePath, resetGeminiAccounts } from '../server/providers/geminiAccounts.js';
import { ProviderError } from '../server/providers/types.js';
import { FakeDb } from './fakeDb.js';

// built at runtime so no credential-shaped literal sits in the source
const KEY_A = ['test', 'gemini', 'key', 'a', '000000'].join('-');
const KEY_B = ['test', 'gemini', 'key', 'b', '111111'].join('-');
const CF_A = 'a'.repeat(32);
const CF_B = 'b'.repeat(32);
const TOK_A = ['cf', 'test', 'token', 'a'].join('-');
const TOK_B = ['cf', 'test', 'token', 'b'].join('-');

const ENV = ['GEMINI_API_KEY', 'GEMINI_API_KEY_SECONDARY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID_SECONDARY', 'CLOUDFLARE_API_TOKEN_SECONDARY'];

beforeEach(() => {
  process.env.GEMINI_API_KEY = KEY_A;
  process.env.GEMINI_API_KEY_SECONDARY = KEY_B;
  process.env.CLOUDFLARE_ACCOUNT_ID = CF_A;
  process.env.CLOUDFLARE_API_TOKEN = TOK_A;
  process.env.CLOUDFLARE_ACCOUNT_ID_SECONDARY = CF_B;
  process.env.CLOUDFLARE_API_TOKEN_SECONDARY = TOK_B;
  H.resetAccountHealth();
  resetGeminiAccounts();
  resetCloudflareDailyLimit();
  resetBudgetState();
  invalidateLimits();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setAdminDb(null);
  for (const k of ENV) delete process.env[k];
});

/* ----------------------------------- helpers ----------------------------------- */

const ok = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
const sse = (...texts: string[]) =>
  new Response(texts.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const rpm429 = (retrySeconds = 20) =>
  new Response(
    JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retrySeconds}s` },
        ],
      },
    }),
    { status: 429 },
  );
const rpd429 = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }],
      },
    }),
    { status: 429 },
  );
const badKey = () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 });

/** A fetch stub that answers per Gemini account (by the key header) and records which account was used. */
function geminiFetch(plan: { A?: (() => Response)[]; B?: (() => Response)[] }) {
  const used: string[] = [];
  const fn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string>)['x-goog-api-key'];
    const acct = key === KEY_A ? 'A' : key === KEY_B ? 'B' : '?';
    used.push(acct);
    const next = plan[acct as 'A' | 'B']?.shift();
    if (!next) throw new Error(`unexpected call on account ${acct}`);
    return next();
  });
  vi.stubGlobal('fetch', fn);
  return used;
}

const params = (model = 'gemini:gemini-3.6-flash') => ({ model, messages: [{ role: 'user' as const, content: 'hi' }] });

async function collect(gen: AsyncGenerator<{ type: string; text?: string }>) {
  let text = '';
  for await (const c of gen) if (c.type === 'delta') text += c.text;
  return text;
}

/* ------------------------------------ Gemini ------------------------------------ */

describe('Gemini accounts', () => {
  it('uses both projects and spreads requests between them', async () => {
    const used = geminiFetch({ A: [() => ok('a'), () => ok('a')], B: [() => ok('b'), () => ok('b')] });
    const p = new GeminiProvider();
    for (let i = 0; i < 4; i++) await p.complete(params());
    expect(used.filter((a) => a === 'A').length).toBe(2);
    expect(used.filter((a) => a === 'B').length).toBe(2);
  });

  it('skips account B when it repeats account A, and works with A alone', async () => {
    process.env.GEMINI_API_KEY_SECONDARY = KEY_A;
    expect(geminiAccounts().map((a) => a.id)).toEqual(['A']);
    delete process.env.GEMINI_API_KEY_SECONDARY;
    const used = geminiFetch({ A: [() => ok('only a')] });
    expect(await new GeminiProvider().complete(params())).toBe('only a');
    expect(used).toEqual(['A']);
  });

  it('a per-minute limit on A moves the same request to B, rests A, and A recovers after its cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-11T18:00:00Z');
    vi.setSystemTime(t0);
    const used = geminiFetch({ A: [() => rpm429(20), () => ok('a again')], B: [() => ok('from b'), () => ok('b2')] });
    const p = new GeminiProvider();
    // force A first
    const first = await p.complete(params());
    expect(['from b', 'a again']).toContain(first);
    if (used[0] === 'A') {
      expect(used).toEqual(['A', 'B']);
      expect(H.cooldownOf('gemini', 'A', 'gemini-3.6-flash')).toMatchObject({ reason: 'rpm' });
      // while A rests, requests go straight to B (no call to A)
      expect(await p.complete(params())).toBe('b2');
      expect(used).toEqual(['A', 'B', 'B']);
      // 60 s (backoff base; Google asked for 20 s) later A is tried again
      vi.setSystemTime(t0 + 61_000);
      expect(H.cooldownOf('gemini', 'A', 'gemini-3.6-flash')).toBeNull();
      expect(await p.complete(params())).toBe('a again');
    }
  });

  it('rate-limit cooldowns back off exponentially and respect the retry hint', () => {
    expect(H.backoffMs(1, 60_000, 900_000)).toBe(60_000);
    expect(H.backoffMs(2, 60_000, 900_000)).toBe(120_000);
    expect(H.backoffMs(3, 60_000, 900_000)).toBe(240_000);
    expect(H.backoffMs(9, 60_000, 900_000)).toBe(900_000);
    expect(H.backoffMs(1, 60_000, 900_000, 300_000)).toBe(300_000);
  });

  it('a daily quota on A rests that model on A until midnight Pacific time; other models keep using A', async () => {
    const used = geminiFetch({ A: [() => rpd429(), () => ok('lite on a')], B: [() => ok('flash on b'), () => ok('lite on b')] });
    const p = new GeminiProvider();
    // the first request may start on either account; repeat until A has failed once
    await p.complete(params());
    if (used[0] !== 'A') await p.complete(params());
    const c = H.cooldownOf('gemini', 'A', 'gemini-3.6-flash');
    expect(c).toMatchObject({ reason: 'rpd' });
    expect(c!.until).toBe(nextPacificMidnight());
    expect(H.cooldownOf('gemini', 'A', 'gemini-3.5-flash-lite')).toBeNull();
  });

  it('both projects limited: no endless retries, a limit error goes to the engine for the next free model', async () => {
    const used = geminiFetch({ A: [() => rpm429()], B: [() => rpm429()] });
    const err = await new GeminiProvider().complete(params()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('rate_limited');
    expect(err.fallbackable).toBe(true);
    expect(used.sort()).toEqual(['A', 'B']);
    // both rest: a new request does not call either project
    const again = await new GeminiProvider().complete(params()).catch((e) => e);
    expect(again.code).toBe('rate_limited');
    expect(used.length).toBe(2);
  });

  it('both daily quotas used up reports the daily limit', async () => {
    geminiFetch({ A: [() => rpd429()], B: [() => rpd429()] });
    const err = await new GeminiProvider().complete(params()).catch((e) => e);
    expect(err.code).toBe('daily_limit');
  });

  it('a rejected key alerts administrators (without the key), rests the whole project and uses the other', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const used = geminiFetch({ A: [() => badKey()], B: [() => ok('b'), () => ok('b'), () => ok('b')] });
    const p = new GeminiProvider();
    await p.complete(params());
    if (used[0] !== 'A') await p.complete(params());
    expect(H.cooldownOf('gemini', 'A', H.ANY_MODEL)).toMatchObject({ reason: 'auth' });
    expect(H.cooldownOf('gemini', 'A', 'gemini-3.1-flash-lite')).toMatchObject({ reason: 'auth' });
    const printed = log.mock.calls.flat().join(' ');
    expect(printed).toMatch(/account A/);
    expect(printed).not.toContain(KEY_A);
    expect(printed).not.toContain(KEY_B);
    // another model also avoids A
    await p.complete(params('gemini:gemini-3.1-flash-lite'));
    expect(used[used.length - 1]).toBe('B');
  });

  it('streaming fails over before the first text, giving one answer', async () => {
    const used = geminiFetch({ A: [() => rpm429()], B: [() => sse('Hel', 'lo')] });
    // make A the first choice
    H.startCooldown('gemini', 'B', 'gemini-3.6-flash', 1, 'rpm');
    await new Promise((r) => setTimeout(r, 5));
    const text = await collect(new GeminiProvider().stream(params()));
    expect(text).toBe('Hello');
    expect(used).toEqual(['A', 'B']);
  });

  it('a failure after text has streamed is not retried on the other project (no duplicate answer)', async () => {
    const broken = () =>
      new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })}\n\ndata: ${JSON.stringify({ error: { code: 503, message: 'overloaded' } })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const used = geminiFetch({ A: [broken], B: [broken] });
    const chunks: string[] = [];
    const err = await (async () => {
      for await (const c of new GeminiProvider().stream(params())) if (c.type === 'delta') chunks.push(c.text);
    })().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(chunks).toEqual(['partial']);
    expect(used.length).toBe(1);
  });

  it('a request the other project would also refuse (bad request) is not retried', async () => {
    const used = geminiFetch({
      A: [() => new Response(JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload' } }), { status: 400 })],
      B: [() => new Response(JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload' } }), { status: 400 })],
    });
    const err = await new GeminiProvider().complete(params()).catch((e) => e);
    expect(err.code).toBe('bad_request');
    expect(used.length).toBe(1);
  });

  it('counts requests per day atomically and skips a project whose daily quota Atlas has already counted', async () => {
    const db = new FakeDb();
    setAdminDb(db as unknown as Firestore);
    db.docs.set(geminiUsagePath(pacificDay()), { 'A.gemini_3_6_flash.requests': 20 });
    const used = geminiFetch({ B: [() => ok('b'), () => ok('b')] });
    const p = new GeminiProvider();
    await p.complete(params());
    await p.complete(params());
    expect(used).toEqual(['B', 'B']);
    const doc = db.docs.get(geminiUsagePath(pacificDay()))!;
    expect(doc['A.gemini_3_6_flash.requests']).toBe(20); // the over-limit count was undone
    expect(doc['B.gemini_3_6_flash.requests']).toBe(2);
    expect(H.cooldownOf('gemini', 'A', 'gemini-3.6-flash')).toMatchObject({ reason: 'rpd' });
  });

  it('the per-minute guard keeps Atlas under 80% of the published limit on each project', async () => {
    const used = geminiFetch({ A: Array.from({ length: 10 }, () => () => ok('a')), B: Array.from({ length: 10 }, () => () => ok('b')) });
    const p = new GeminiProvider();
    // 3.6 Flash: 5 RPM -> 4 per project per minute -> 8 in total, then the guard stops
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => p.complete(params())));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(8);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('rate_limited');
    expect(used.filter((a) => a === 'A').length).toBe(4);
    expect(used.filter((a) => a === 'B').length).toBe(4);
  });

  it('embeddings move to the other project on a limit (same model, same vectors)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        calls++;
        const key = (init?.headers as Record<string, string>)['x-goog-api-key'];
        if (key === KEY_A) return rpm429();
        return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }] }), { status: 200 });
      }),
    );
    H.startCooldown('gemini', 'B', 'gemini-embedding-001', 1, 'rpm');
    await new Promise((r) => setTimeout(r, 5));
    expect(await new GeminiProvider().embed('gemini:gemini-embedding-001', ['x'])).toEqual([[0.1, 0.2]]);
    expect(calls).toBe(2);
  });

  it('lists models from both projects and never exposes a key in errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        const key = (init?.headers as Record<string, string>)['x-goog-api-key'];
        if (key === KEY_A) return badKey();
        return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
      }),
    );
    const models = await new GeminiProvider().listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini:gemini-3.6-flash']);
    const err = mapCloudflareError(401, JSON.stringify({ errors: [{ code: 10000, message: `bad ${TOK_A}` }] }), 'A');
    expect(err.message).not.toContain(TOK_A);
  });

  it('Pacific midnight is the next day change in Los Angeles, across daylight-saving changes', () => {
    for (const iso of ['2026-11-11T18:00:00Z', '2026-11-01T06:30:00Z', '2026-03-08T09:59:00Z', '2026-07-01T06:59:59Z']) {
      const now = Date.parse(iso);
      const m = nextPacificMidnight(now);
      expect(m).toBeGreaterThan(now);
      expect(pacificDay(m)).not.toBe(pacificDay(now));
      expect(pacificDay(m - 1)).toBe(pacificDay(now));
    }
  });
});

/* ---------------------------------- Cloudflare ---------------------------------- */

describe('Cloudflare accounts', () => {
  const db = () => {
    const d = new FakeDb();
    setAdminDb(d as unknown as Firestore);
    return d;
  };
  const day = () => usagePath(utcDay());

  it('builds requests for the chosen account only', () => {
    expect(aiBase('A')).toContain(CF_A);
    expect(aiBase('B')).toContain(CF_B);
    delete process.env.CLOUDFLARE_API_TOKEN_SECONDARY;
    expect(() => aiBase('B')).toThrow(/not configured/);
  });

  it('reserves on the least-used account; usage from before accounts were tracked counts toward A', async () => {
    const d = db();
    d.docs.set(day(), { neurons: 8800 });
    expect(accountNeurons(d.docs.get(day()), 'A')).toBe(8800);
    const r = await reserveNeurons(d as unknown as Firestore, 150);
    expect(r).toMatchObject({ ok: true, account: 'B' });
    expect(d.docs.get(day())!['accounts.B.claimed']).toBe(150);
    if (r.ok) await r.settle(104, { uid: 'u1', model: 'x', type: 'text', ok: true });
    const doc = d.docs.get(day())!;
    expect(doc['accounts.B.claimed']).toBe(0);
    expect(doc['accounts.B.neurons']).toBe(104);
    expect(doc.neurons).toBe(8904);
    expect(accountNeurons(doc, 'A')).toBe(8800);
  });

  it('each account keeps its own cap; when both are full nothing runs (never paid usage)', async () => {
    const d = db();
    d.docs.set(day(), { neurons: 8950 + 8950, 'accounts.B.neurons': 8950 });
    const r = await reserveNeurons(d as unknown as Firestore, 60);
    expect(r).toMatchObject({ ok: false, reason: 'app_cap' });
  });

  it('concurrent reservations never take more than the cap of an account', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID_SECONDARY;
    const d = db();
    d.docs.set(day(), { neurons: 8700 });
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveNeurons(d as unknown as Firestore, 100)));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(d.docs.get(day())!['accounts.A.claimed']).toBe(300);
  });

  it('a used-up daily allowance on A moves the call to B before any Neurons are spent', async () => {
    const d = db();
    d.docs.set(day(), { neurons: 100, 'accounts.B.neurons': 2000 });
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes(CF_A)) return new Response(JSON.stringify({ errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] }), { status: 429 });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'safe' } }] }), { status: 200, headers: { 'cf-ai-neurons': '3' } });
      }),
    );
    const r = await reserveNeurons(d as unknown as Firestore, 50);
    expect(r).toMatchObject({ ok: true, account: 'A' });
    if (!r.ok) return;
    const { chatOnce } = await import('../server/cloudflare/client.js');
    const out = await r.run(() => chatOnce('@cf/meta/llama-guard-3-8b', [{ role: 'user', content: 'x' }]));
    expect(out.text).toBe('safe');
    expect(r.account).toBe('B');
    expect(urls.map((u) => (u.includes(CF_A) ? 'A' : 'B'))).toEqual(['A', 'B']);
    expect(cloudflareDailyLimitActive(Date.now(), 'A')).toBe(true);
    expect(cloudflareDailyLimitActive()).toBe(false); // B still has its allowance
    const doc = d.docs.get(day())!;
    expect(doc['accounts.A.claimed']).toBe(0);
    expect(doc['accounts.B.claimed']).toBe(50);
    await r.settle(out.neurons, { uid: 'u1', model: 'safety', type: 'safety', ok: true });
    expect(d.docs.get(day())!['accounts.B.neurons']).toBe(2003);
    // the next reservation skips A for the rest of the day
    const next = await reserveNeurons(d as unknown as Firestore, 50);
    expect(next).toMatchObject({ ok: true, account: 'B' });
  });

  it('rejected credentials on one account alert without the token and use the other account', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = db();
    d.docs.set(day(), { neurons: 0, 'accounts.B.neurons': 10 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes(CF_A)
          ? new Response(JSON.stringify({ errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 401 })
          : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
      ),
    );
    const r = await reserveNeurons(d as unknown as Firestore, 10);
    if (!r.ok) throw new Error('no reservation');
    const { chatOnce } = await import('../server/cloudflare/client.js');
    expect((await r.run(() => chatOnce('@cf/x', []))).text).toBe('ok');
    const printed = log.mock.calls.flat().join(' ');
    expect(printed).toMatch(/account A/);
    expect(printed).not.toContain(TOK_A);
    expect(printed).not.toContain(CF_A);
    expect(H.cooldownOf('cloudflare', 'A', H.ANY_MODEL)).toMatchObject({ reason: 'auth' });
  });

  it('does not repeat a call on the other account once Neurons were spent', async () => {
    const d = db();
    d.docs.set(day(), { neurons: 0, 'accounts.B.neurons': 10 });
    const r = await reserveNeurons(d as unknown as Firestore, 10);
    if (!r.ok) throw new Error('no reservation');
    let calls = 0;
    const err = await r
      .run(async () => {
        calls++;
        throw Object.assign(new ProviderError('provider_error', 'boom'), { neurons: 4 });
      })
      .catch((e) => e);
    expect(err.code).toBe('provider_error');
    expect(calls).toBe(1);
    expect(r.account).toBe('A');
  });

  it('the chat model streams on the account its reservation was made on', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    let text = '';
    for await (const c of new CloudflareProvider().stream({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: [{ role: 'user', content: 'x' }], account: 'B' }))
      if (c.type === 'delta') text += c.text;
    expect(text).toBe('hi');
    expect(urls[0]).toContain(CF_B);
  });
});
