import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from './fakeDb.js';

// API Environment Manager: credential sets, request pinning, isolation, the Temporary ceiling,
// per-environment allowances and the Super Admin operations. No real provider is called here.
let db: FakeDb;
vi.mock('../server/admin.js', async (orig) => ({ ...(await orig<object>()), adminConfigured: () => true, adminDb: async () => db.asFirestore() }));

const E = await import('../server/environments/index.js');
const { defaultEnvironmentConfig, normalizeEnvironmentConfig } = await import('../server/shared/environments.js');
const { geminiAccounts } = await import('../server/providers/geminiAccounts.js');
const { GeminiProvider } = await import('../server/providers/gemini.js');
const { OpenRouterProvider } = await import('../server/providers/openrouter.js');
const { cloudflareAccountIds, cloudflareConfigured } = await import('../server/cloudflare/client.js');
const { accountNeurons } = await import('../server/cloudflare/budget.js');
const { TavilySearch } = await import('../server/search/tavily.js');
const { SerpApiSearch } = await import('../server/search/serpapi.js');
const { searchUsageField } = await import('../server/search/store.js');
const { sameEnvironment } = await import('../server/search/router.js');
const { markFailed, coolingDown, resetHealth } = await import('../server/providers/health.js');
const { accountPath, usageConfigPath, loadUsageConfigInfo, clearUsageCache } = await import('../server/usage/allowance.js');
const { environmentAdmin } = await import('../server/environments/admin.js');
const { checkHealth } = await import('../server/environments/health.js');
const { handle } = await import('../server/http.js');
import type { EnvId, EnvironmentConfig, EnvProvider, HealthResult } from '../server/shared/environments.js';

const KEYS = {
  GEMINI_API_KEY: 'gem-main-A',
  GEMINI_API_KEY_SECONDARY: 'gem-sec-B',
  GEMINI_API_KEY_TEMPORARY: 'gem-temp-T',
  OPENROUTER_API_KEY: 'or-main',
  OPENROUTER_API_KEY_TEMPORARY: 'or-temp',
  TAVILY_API_KEY: 'tv-main',
  TAVILY_API_KEY_TEMPORARY: 'tv-temp',
  SERPAPI_API_KEY: 'sp-main',
  SERPAPI_API_KEY_TEMPORARY: 'sp-temp',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'cf-tok-A',
  CLOUDFLARE_ACCOUNT_ID_SECONDARY: 'b'.repeat(32),
  CLOUDFLARE_API_TOKEN_SECONDARY: 'cf-tok-B',
  CLOUDFLARE_ACCOUNT_ID_TEMPORARY: 'c'.repeat(32),
  CLOUDFLARE_API_TOKEN_TEMPORARY: 'cf-tok-T',
};
const saved: Record<string, string | undefined> = {};

function cfg(change: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return { ...defaultEnvironmentConfig(), ...change };
}
const all = (e: EnvId): EnvironmentConfig['providers'] => ({
  gemini: e,
  cloudflare: e,
  openrouter: e === 'secondary' ? 'main' : e,
  tavily: e === 'secondary' ? 'main' : e,
  serpapi: e === 'secondary' ? 'main' : e,
});
const pinned = <T,>(c: EnvironmentConfig, fn: () => T) => E.runPinned({ config: c, usageEnv: c.global }, fn);

beforeEach(() => {
  db = new FakeDb();
  for (const [k, v] of Object.entries(KEYS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  E.setEnvironmentCache(null);
  resetHealth();
  clearUsageCache();
});
afterEach(() => {
  for (const k of Object.keys(KEYS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('credential sets', () => {
  it('Main pools A and B (today’s behaviour), Secondary is B only, Temporary is T only', () => {
    expect(E.geminiCredentials('main').map((c) => c.id)).toEqual(['A', 'B']);
    expect(E.geminiCredentials('secondary').map((c) => c.id)).toEqual(['B']);
    expect(E.geminiCredentials('temporary')).toEqual([{ id: 'T', key: 'gem-temp-T' }]);
    expect(E.cloudflareCredentials('main').map((c) => c.id)).toEqual(['A', 'B']);
    expect(E.cloudflareCredentials('secondary').map((c) => c.id)).toEqual(['B']);
    expect(E.cloudflareCredentials('temporary').map((c) => c.id)).toEqual(['T']);
  });

  it('OpenRouter, Tavily and SerpAPI have no Secondary set', () => {
    expect(E.apiKeyFor('openrouter', 'secondary')).toBe('');
    expect(E.apiKeyFor('tavily', 'temporary')).toBe('tv-temp');
    expect(E.apiKeyFor('serpapi', 'main')).toBe('sp-main');
    // a stored config can never put them on Secondary
    const c = normalizeEnvironmentConfig({ providers: { openrouter: 'secondary', gemini: 'secondary', tavily: 'bogus' } });
    expect(c.providers).toMatchObject({ openrouter: 'main', gemini: 'secondary', tavily: 'main' });
  });

  it('reports variable names only, and duplicate keys as shared capacity', () => {
    const vars = E.credentialVariables('gemini', 'temporary');
    expect(vars).toEqual([{ name: 'GEMINI_API_KEY_TEMPORARY', set: true, optional: false }]);
    expect(JSON.stringify(vars)).not.toContain('gem-temp-T');
    expect(E.sharedCredentials('gemini', 'temporary', ['main', 'secondary', 'temporary'])).toEqual([]);
    process.env.GEMINI_API_KEY_TEMPORARY = 'gem-main-A'; // the same key as Main's account A
    expect(E.sharedCredentials('gemini', 'temporary', ['main', 'secondary', 'temporary'])).toEqual(['main']);
  });

  it('missing temporary credentials mean "not configured", never Main’s', () => {
    delete process.env.GEMINI_API_KEY_TEMPORARY;
    delete process.env.OPENROUTER_API_KEY_TEMPORARY;
    pinned(cfg({ providers: all('temporary'), global: 'temporary' }), () => {
      expect(geminiAccounts()).toEqual([]);
      expect(new GeminiProvider().isConfigured()).toBe(false);
      expect(new OpenRouterProvider().isConfigured()).toBe(false);
      expect(E.credentialsConfigured('gemini', 'temporary')).toBe(false);
    });
  });
});

describe('request pinning', () => {
  it('providers use the pinned environment’s accounts and keys', () => {
    pinned(cfg({ providers: all('temporary') }), () => {
      expect(geminiAccounts().map((a) => a.key)).toEqual(['gem-temp-T']);
      expect(cloudflareAccountIds()).toEqual(['T']);
      expect(new TavilySearch().isConfigured()).toBe(true);
    });
    pinned(cfg({ providers: all('secondary') }), () => {
      expect(geminiAccounts().map((a) => a.id)).toEqual(['B']);
      expect(cloudflareAccountIds()).toEqual(['B']);
    });
    // no request context (unit code, scripts): the stored default, Main
    expect(geminiAccounts().map((a) => a.id)).toEqual(['A', 'B']);
  });

  it('a switch during a request does not change that request', async () => {
    const seen: string[] = [];
    const h = handle(async () => {
      seen.push(geminiAccounts().map((a) => a.id).join(''));
      // an administrator switches everything to Temporary while this request runs
      await db.asFirestore().set(E.ENV_CONFIG_PATH, { ...cfg({ providers: all('temporary'), global: 'temporary', version: 2 }) });
      E.setEnvironmentCache(null);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(geminiAccounts().map((a) => a.id).join(''));
      return new Response('ok');
    });
    await h(new Request('http://x/api/test'));
    expect(seen).toEqual(['AB', 'AB']);
    // the next request starts with the new configuration
    await handle(async () => {
      seen.push(geminiAccounts().map((a) => a.id).join(''));
      return new Response('ok');
    })(new Request('http://x/api/test'));
    expect(seen[2]).toBe('T');
  });

  it('a streamed reply keeps the pinned environment after the handler returned', async () => {
    db.docs.set(E.ENV_CONFIG_PATH, cfg({ providers: all('temporary'), version: 1 }) as unknown as Record<string, unknown>);
    let late = '';
    const res = await handle(async () => {
      const stream = new ReadableStream({
        start(controller) {
          void (async () => {
            await new Promise((r) => setTimeout(r, 10));
            late = geminiAccounts().map((a) => a.id).join('');
            controller.close();
          })();
        },
      });
      return new Response(stream);
    })(new Request('http://x/api/test'));
    E.setEnvironmentCache(cfg()); // switched back to Main meanwhile
    await res.text();
    expect(late).toBe('T');
  });

  it('settings that cannot be read make providers refuse instead of guessing Main', () => {
    E.runPinned({ config: cfg(), usageEnv: 'main', unavailable: true }, () => {
      expect(geminiAccounts()).toEqual([]);
      expect(() => E.envOf('openrouter')).toThrow(/could not be loaded/);
    });
  });
});

describe('isolation and fallback', () => {
  it('an environment that is switched off is unavailable (no silent fallback)', () => {
    const c = cfg({ providers: all('temporary'), disabled: { ...cfg().disabled, gemini: ['temporary'] } });
    pinned(c, () => {
      expect(geminiAccounts()).toEqual([]);
      expect(cloudflareConfigured()).toBe(true);
    });
  });

  it('the model chain stays in the selected model’s environment', () => {
    const providerOf = (id: string): EnvProvider => (id.startsWith('gemini:') ? 'gemini' : 'openrouter');
    const chain = ['gemini:gemini-3.6-flash', 'gemini:gemini-3.5-flash-lite', 'x/y:free'];
    // mixed: Gemini on Temporary, OpenRouter on Main: the OpenRouter model is not used as a fallback
    pinned(cfg({ providers: { ...all('main'), gemini: 'temporary' } }), () => {
      expect(E.sameEnvironmentChain(chain, providerOf)).toEqual(chain.slice(0, 2));
    });
    // everything on Temporary: the whole chain
    pinned(cfg({ providers: all('temporary') }), () => expect(E.sameEnvironmentChain(chain, providerOf)).toEqual(chain));
    // Temporary Gemini switched off and OpenRouter elsewhere: a clear error, nothing on Main
    pinned(cfg({ providers: { ...all('main'), gemini: 'temporary' }, disabled: { ...cfg().disabled, gemini: ['temporary'] } }), () => {
      expect(() => E.sameEnvironmentChain(chain, providerOf)).toThrow(/No AI model is available in the Temporary Public Testing environment/);
    });
  });

  it('search fallback stays in one environment', () => {
    pinned(cfg({ providers: { ...all('main'), tavily: 'temporary' } }), () => {
      expect(sameEnvironment(['tavily', 'serpapi'], () => true)).toEqual(['tavily']);
      expect(searchUsageField('tavily')).toBe('search_temporary');
      expect(searchUsageField('serpapi')).toBe('search');
    });
  });

  it('model health is kept per environment', () => {
    pinned(cfg({ providers: all('temporary') }), () => markFailed('gemini:gemini-3.6-flash', 'rate_limited'));
    expect(coolingDown('gemini:gemini-3.6-flash')).toBe(false); // Main unaffected
    pinned(cfg({ providers: all('temporary') }), () => expect(coolingDown('gemini:gemini-3.6-flash')).toBe(true));
  });

  it('Cloudflare Neurons of account T are not counted as A', () => {
    const data = { neurons: 100, accounts: { B: { neurons: 30 }, T: { neurons: 20 } } };
    expect(accountNeurons(data, 'A')).toBe(50);
    expect(accountNeurons(data, 'T')).toBe(20);
  });

  it('a Gemini request on Temporary sends only the Temporary key', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['x-goog-api-key']);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }), { status: 200 });
    });
    const out = await pinned(cfg({ providers: all('temporary') }), () =>
      new GeminiProvider().complete({ model: 'gemini:gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(out).toBe('hi');
    expect(keys).toEqual(['gem-temp-T']);
  });

  it('a rejected Temporary key is never retried with Main credentials', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['x-goog-api-key']);
      return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 });
    });
    await expect(
      pinned(cfg({ providers: all('temporary') }), () => new GeminiProvider().complete({ model: 'gemini:gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toBeTruthy();
    expect(keys.every((k) => k === 'gem-temp-T')).toBe(true);
  });
});

describe('Temporary ceiling', () => {
  it('counts each request and refuses past the daily ceiling, without touching Main', async () => {
    const c = cfg({ providers: all('temporary'), temporaryCeiling: { daily: 2, weekly: 10 } });
    await pinned(c, () => E.chargeProviderRequest('gemini'));
    await pinned(c, () => E.chargeProviderRequest('tavily'));
    await expect(pinned(c, () => E.chargeProviderRequest('openrouter'))).rejects.toMatchObject({ code: 'environment_limit' });
    const day = db.docs.get(E.envUsagePath('temporary', 'd', E.utcDay()))!;
    expect(day.total).toBe(2); // the refused request was given back
    expect(day.refused).toBe(1);
    // Main keeps working and is counted separately
    await pinned(cfg(), () => E.chargeProviderRequest('gemini'));
    await new Promise((r) => setTimeout(r, 0));
    expect(db.docs.get(E.envUsagePath('main', 'd', E.utcDay()))!.total).toBe(1);
  });

  it('the weekly ceiling applies too', async () => {
    const c = cfg({ providers: all('temporary'), temporaryCeiling: { daily: 100, weekly: 1 } });
    await pinned(c, () => E.chargeProviderRequest('gemini'));
    await expect(pinned(c, () => E.chargeProviderRequest('gemini'))).rejects.toThrow(/weekly request ceiling/);
  });

  it('a search over the ceiling is refused as a search error (no request sent)', async () => {
    let sent = 0;
    vi.stubGlobal('fetch', async () => {
      sent++;
      return new Response('{}');
    });
    const c = cfg({ providers: all('temporary'), temporaryCeiling: { daily: 0, weekly: 0 } });
    await expect(pinned(c, () => new SerpApiSearch().search('q', { kind: 'web', max: 3 }))).rejects.toMatchObject({ name: 'SearchError', code: 'quota' });
    expect(sent).toBe(0);
  });

  it('a switched-off provider refuses before anything is sent', async () => {
    const c = cfg({ providers: all('temporary'), disabled: { ...cfg().disabled, tavily: ['temporary'] } });
    await expect(pinned(c, () => E.chargeProviderRequest('tavily'))).rejects.toThrow(/switched off/);
  });
});

describe('per-environment allowances', () => {
  it('uses separate documents per environment and Main’s settings until its own are saved', async () => {
    db.docs.set('config/usage', { enabled: true, defaultProfile: 'premium' });
    expect(accountPath('u1')).toBe('usageAccounts/u1');
    await E.withUsageEnvironment('temporary', async () => {
      expect(accountPath('u1')).toBe('usageAccounts_temporary/u1');
      expect(usageConfigPath()).toBe('config/usage_temporary');
      const info = await loadUsageConfigInfo(db.asFirestore(), true);
      expect(info.inherited).toBe(true);
      expect(info.value.defaultProfile).toBe('premium');
    });
    db.docs.set('config/usage_temporary', { enabled: true, defaultProfile: 'restricted' });
    await E.withUsageEnvironment('temporary', async () => {
      const info = await loadUsageConfigInfo(db.asFirestore(), true);
      expect(info).toMatchObject({ inherited: false, value: { defaultProfile: 'restricted' } });
    });
    // Main is unchanged
    expect((await loadUsageConfigInfo(db.asFirestore(), true)).value.defaultProfile).toBe('premium');
  });
});

describe('Super Admin operations', () => {
  const actor = { uid: 'admin1', email: 'owner@example.com' };
  const healthy = async (): Promise<HealthResult> => ({ ok: true, status: 'healthy', detail: 'Key accepted.', checkedAt: 1, ms: 1 });

  it('switches everything after the health checks pass, versioned and audited', async () => {
    const r = (await environmentAdmin({ db: db.asFirestore(), actor, check: healthy }, { op: 'switch', scope: 'global', environment: 'temporary', confirm: true, reason: 'public test' })) as {
      config: EnvironmentConfig;
    };
    expect(r.config.providers).toEqual(all('temporary'));
    expect(r.config).toMatchObject({ global: 'temporary', version: 1, updatedBy: 'owner@example.com' });
    expect(db.docs.get(E.ENV_CONFIG_PATH)).toMatchObject({ global: 'temporary' });
    const logs = db.under('adminLogs/').map((p) => db.docs.get(p)!);
    expect(logs[0]).toMatchObject({ action: 'environment_switched', adminEmail: 'owner@example.com' });
    expect(String(logs[0].detail)).toContain('public test');
    const audit = db.under('envAudit/').map((p) => db.docs.get(p)!);
    expect(audit[0]).toMatchObject({ result: 'success', providers: ['gemini', 'cloudflare', 'openrouter', 'tavily', 'serpapi'] });
    // the new config is used at once on this instance
    expect((await E.requestPin()).config.version).toBe(1);
  });

  it('Secondary everywhere: providers without a Secondary set show Main', async () => {
    const r = (await environmentAdmin({ db: db.asFirestore(), actor, check: healthy }, { op: 'switch', scope: 'global', environment: 'secondary', confirm: true })) as {
      config: EnvironmentConfig;
    };
    expect(r.config.providers).toEqual({ gemini: 'secondary', cloudflare: 'secondary', openrouter: 'main', tavily: 'main', serpapi: 'main' });
  });

  it('refuses a switch when a check fails or credentials are missing (nothing changes, refusal audited)', async () => {
    delete process.env.TAVILY_API_KEY_TEMPORARY;
    const failing = async (p: EnvProvider): Promise<HealthResult> =>
      p === 'gemini' ? { ok: false, status: 'invalid', detail: 'Google rejected the key.', checkedAt: 1, ms: 1 } : healthy();
    await expect(
      environmentAdmin({ db: db.asFirestore(), actor, check: failing }, { op: 'switch', scope: 'global', environment: 'temporary', confirm: true }),
    ).rejects.toMatchObject({ status: 409, code: 'switch_refused' });
    expect(db.docs.get(E.ENV_CONFIG_PATH)).toBeUndefined();
    const audit = db.under('envAudit/').map((p) => db.docs.get(p)!);
    expect(audit[0].result).toBe('refused');
    expect(String(audit[0].detail)).toMatch(/TAVILY_API_KEY_TEMPORARY/);
    expect(String(audit[0].detail)).toMatch(/Google rejected the key/);
  });

  it('per-provider switching, with no pretend Secondary', async () => {
    await expect(
      environmentAdmin({ db: db.asFirestore(), actor, check: healthy }, { op: 'switch', scope: 'provider', provider: 'openrouter', environment: 'secondary', confirm: true }),
    ).rejects.toMatchObject({ status: 400 });
    const r = (await environmentAdmin({ db: db.asFirestore(), actor, check: healthy }, { op: 'switch', scope: 'provider', provider: 'gemini', environment: 'secondary', confirm: true })) as {
      config: EnvironmentConfig;
    };
    expect(r.config.providers).toMatchObject({ gemini: 'secondary', openrouter: 'main' });
    expect(r.config.global).toBe('main');
  });

  it('emergency switch-off, ceiling changes and status without secrets', async () => {
    await environmentAdmin({ db: db.asFirestore(), actor }, { op: 'disable', provider: 'gemini', environment: 'temporary', disabled: true, confirm: true });
    await environmentAdmin({ db: db.asFirestore(), actor }, { op: 'ceiling', daily: 50, weekly: 200 });
    await expect(environmentAdmin({ db: db.asFirestore(), actor }, { op: 'ceiling', daily: 50, weekly: 10 })).rejects.toMatchObject({ status: 400 });
    const s = (await environmentAdmin({ db: db.asFirestore(), actor }, { op: 'status' })) as { config: EnvironmentConfig };
    expect(s.config.disabled.gemini).toEqual(['temporary']);
    expect(s.config.temporaryCeiling).toEqual({ daily: 50, weekly: 200 });
    const text = JSON.stringify(s);
    for (const v of Object.values(KEYS)) expect(text).not.toContain(v);
  });
});

describe('health checks', () => {
  it('keeps only plan figures from SerpAPI (never the key or account email)', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ api_key: 'sp-temp', account_email: 'someone@example.com', plan_name: 'Free Plan', searches_per_month: 250, this_month_usage: 3, total_searches_left: 247 })),
    );
    const r = await checkHealth('serpapi', 'temporary');
    expect(r).toMatchObject({ ok: true, account: { plan: 'Free Plan', searchesLeft: 247 } });
    const text = JSON.stringify(r) + JSON.stringify(db.docs.get('envHealth/serpapi_temporary'));
    expect(text).not.toContain('sp-temp');
    expect(text).not.toContain('someone@example.com');
  });

  it('reports a rejected key and a missing one clearly', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    expect(await checkHealth('openrouter', 'temporary')).toMatchObject({ ok: false, status: 'invalid' });
    delete process.env.CLOUDFLARE_API_TOKEN_TEMPORARY;
    expect(await checkHealth('cloudflare', 'temporary')).toMatchObject({ ok: false, status: 'missing' });
  });

  it('catches a Gemini project without a free tier (the model list alone looks fine)', async () => {
    const free = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The Gemini API free tier is not available for this project. Please set up billing.' } };
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).includes(':generateContent')
        ? new Response(JSON.stringify(free), { status: 403 })
        : new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.6-flash' }] })),
    );
    const r = await checkHealth('gemini', 'temporary');
    expect(r).toMatchObject({ ok: false, status: 'invalid' });
    expect(r.detail).toMatch(/no Gemini free tier/);

    // a rate-limited probe still proves the key and project work
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).includes(':generateContent') ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ models: [] })),
    );
    expect(await checkHealth('gemini', 'temporary')).toMatchObject({ ok: true, status: 'healthy' });
  });
});
