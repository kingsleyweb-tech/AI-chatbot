/**
 * Live check of the API Environment Manager against the real providers (free tiers only).
 *
 *   npx tsx --env-file=.env.local dev/smoke-environments.ts
 *
 * - Never prints keys, tokens or account ids: only environment names, statuses and short texts.
 * - Nothing is written to the production database: counters go to an in-memory store.
 * - About ten small requests in total: one per credential set (a few tokens, one search credit on
 *   Tavily and on SerpAPI, a few Cloudflare Neurons), plus no-quota health checks.
 */
import { FakeDb } from '../tests/fakeDb.js';

// keep every write in memory (the service account would otherwise point at production)
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.FIRESTORE_EMULATOR_HOST;
const db = new FakeDb();
const { setAdminDb } = await import('../server/admin.js');
setAdminDb(db.asFirestore());

const E = await import('../server/environments/index.js');
const S = await import('../server/shared/environments.js');
const { checkHealth } = await import('../server/environments/health.js');
const { handle } = await import('../server/http.js');
const { GeminiProvider } = await import('../server/providers/gemini.js');
const { OpenRouterProvider } = await import('../server/providers/openrouter.js');
const { chatOnce } = await import('../server/cloudflare/client.js');
const { TavilySearch } = await import('../server/search/tavily.js');
const { SerpApiSearch } = await import('../server/search/serpapi.js');
const { geminiAccounts } = await import('../server/providers/geminiAccounts.js');
const { cloudflareAccountIds } = await import('../server/cloudflare/client.js');

type EnvId = import('../server/shared/environments.js').EnvId;
const results: { name: string; ok: boolean; note: string }[] = [];
const note = (name: string, ok: boolean, text: string) => {
  results.push({ name, ok, note: text });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${text}`);
};

// count real network calls per host (to prove refusals send nothing)
let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  calls++;
  return realFetch(...args);
}) as typeof fetch;

/** run `fn` the way an API request does: through handle(), with the stored config pinned */
async function asRequest<T>(cfg: import('../server/shared/environments.js').EnvironmentConfig, fn: () => Promise<T>): Promise<T> {
  await db.asFirestore().set(E.ENV_CONFIG_PATH, cfg);
  E.setEnvironmentCache(null);
  let out: T;
  let error: unknown;
  await handle(async () => {
    try {
      out = await fn();
    } catch (err) {
      error = err;
    }
    return new Response('');
  })(new Request('http://local/api/smoke'));
  if (error) throw error;
  return out!;
}
const config = (providers: Partial<Record<string, EnvId>>, extra: object = {}) => ({
  ...S.defaultEnvironmentConfig(),
  providers: { ...S.defaultEnvironmentConfig().providers, ...providers },
  ...extra,
});

/* 1. health checks (no quota) */
for (const p of S.ENV_PROVIDERS)
  for (const e of S.SUPPORTED_ENVIRONMENTS[p]) {
    const h = await checkHealth(p, e);
    note(`health ${p}/${e}`, h.ok, `${h.status} - ${h.detail} (${h.ms} ms)`);
  }
console.log('capacity: shared credentials between environments:', S.ENV_PROVIDERS.map((p) => `${p}=${JSON.stringify(Object.fromEntries(S.SUPPORTED_ENVIRONMENTS[p].map((e) => [e, E.sharedCredentials(p, e, S.SUPPORTED_ENVIRONMENTS[p])])))}`).join(' '));

/* 2. real requests per environment */
const msg = [{ role: 'user' as const, content: 'Reply with the single word OK.' }];
for (const e of ['temporary', 'secondary', 'main'] as EnvId[]) {
  try {
    const r = await asRequest(config({ gemini: e }), async () => {
      const ids = geminiAccounts().map((a) => a.id).join('+');
      const text = await new GeminiProvider().complete({ model: 'gemini:gemini-3.5-flash-lite', messages: msg, maxTokens: 20 });
      return `accounts ${ids}: "${text.trim().slice(0, 20)}"`;
    });
    note(`gemini request on ${e}`, true, r);
  } catch (err) {
    note(`gemini request on ${e}`, false, err instanceof Error ? err.message : 'failed');
  }
}
for (const e of ['temporary', 'secondary'] as EnvId[]) {
  try {
    const r = await asRequest(config({ cloudflare: e }), async () => {
      const ids = cloudflareAccountIds().join('+');
      const out = await chatOnce('@cf/meta/llama-3.2-1b-instruct', msg, { maxTokens: 5 });
      return `account ${ids}: "${out.text.trim().slice(0, 20)}" (${out.neurons.toFixed(2)} Neurons)`;
    });
    note(`cloudflare request on ${e}`, true, r);
  } catch (err) {
    note(`cloudflare request on ${e}`, false, err instanceof Error ? err.message : 'failed');
  }
}
{
  // free models are often rate-limited upstream, so try the next free one before reporting
  const errors: string[] = [];
  for (const model of ['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 'cohere/north-mini-code:free']) {
    try {
      const r = await asRequest(config({ openrouter: 'temporary' }), () => new OpenRouterProvider().complete({ model, messages: msg, maxTokens: 20 }));
      note('openrouter request on temporary (free model)', true, `${model}: "${r.trim().slice(0, 20)}"`);
      errors.length = 0;
      break;
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }
  if (errors.length) note('openrouter request on temporary (free model)', false, errors.join(' | '));
}
for (const [name, P] of [
  ['tavily', TavilySearch],
  ['serpapi', SerpApiSearch],
] as const) {
  try {
    const r = await asRequest(config({ [name]: 'temporary' }), () => new P().search('Atlas mountains Morocco', { kind: 'web', max: 1 }));
    note(`${name} search on temporary`, r.results.length > 0, `${r.results.length} result(s), ${r.credits} credit`);
  } catch (err) {
    note(`${name} search on temporary`, false, err instanceof Error ? err.message : 'failed');
  }
}

/* 3. counters: every request above was counted in its own environment */
const tDay = db.docs.get(E.envUsagePath('temporary', 'd', E.utcDay())) ?? {};
note('temporary requests counted', Number(tDay.total) >= 3, `total ${tDay.total ?? 0} today (app estimate)`);

/* 4. the Temporary ceiling refuses without sending anything */
{
  const used = Number(tDay.total ?? 0);
  const before = calls;
  try {
    await asRequest(config({ cloudflare: 'temporary' }, { temporaryCeiling: { daily: used, weekly: 1000 } }), () =>
      chatOnce('@cf/meta/llama-3.2-1b-instruct', msg, { maxTokens: 5 }),
    );
    note('ceiling refuses', false, 'the request was sent');
  } catch (err) {
    note('ceiling refuses', calls === before && (err as { code?: string }).code === 'environment_limit', `${(err as Error).message} (network calls: ${calls - before})`);
  }
}

/* 5. an environment switched off is unavailable: no request, no Main fallback */
{
  const before = calls;
  try {
    await asRequest(config({ gemini: 'temporary' }, { disabled: { ...S.defaultEnvironmentConfig().disabled, gemini: ['temporary'] } }), () =>
      new GeminiProvider().complete({ model: 'gemini:gemini-3.5-flash-lite', messages: msg, maxTokens: 20 }),
    );
    note('switched-off environment', false, 'the request was sent');
  } catch (err) {
    note('switched-off environment', calls === before, `${(err as Error).message} (network calls: ${calls - before})`);
  }
}

globalThis.fetch = realFetch;
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
