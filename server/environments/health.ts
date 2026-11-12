/**
 * Credential health checks for the API Environment Manager.
 *
 * Checks use endpoints that cost no quota (model lists, key/account status) wherever that proves the
 * credentials work. Gemini is the exception: Google lists models (and counts tokens) even for a
 * project whose free tier is unavailable, so each Gemini account also makes one generate request
 * capped at a single output token on the Flash-Lite model. Results hold no secrets: only status, timing and what the provider
 * reports about the plan. Request URLs are never logged (SerpAPI puts the key in the query string).
 */
import { adminConfigured, adminDb } from '../admin.js';
import { modelConfig } from '../config/models.js';
import { SERVER_TIME } from '../firestore.js';
import type { EnvId, EnvProvider, HealthResult } from '../shared/environments.js';
import { apiKeyFor, cloudflareCredentials, geminiCredentials } from './index.js';

export const healthPath = (p: EnvProvider, e: EnvId) => `envHealth/${p}_${e}`;
const TIMEOUT = 10_000;
/** Tavily's /usage endpoint regularly takes 8-10 s to answer */
const SLOW_TIMEOUT = 25_000;
/** the cheapest free Gemini model, used for the one-token generate probe */
const PROBE_MODEL = 'gemini-3.5-flash-lite';

type Partial = Omit<HealthResult, 'checkedAt' | 'ms'>;
const missing = (what: string): Partial => ({ ok: false, status: 'missing', detail: `${what} not set on the server.` });

async function get(url: string, headers: Record<string, string>, timeout = TIMEOUT): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
}

/** One generate request with a single output token: proves the project may actually use Gemini. */
async function geminiProbe(key: string): Promise<{ ok: true; busy: boolean } | { ok: false; status: number; message: string }> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${PROBE_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'OK' }] }], generationConfig: { maxOutputTokens: 1 } }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.ok) return { ok: true, busy: false };
  // a rate limit means the key and project work; the free requests are just used up for now
  if (res.status === 429) return { ok: true, busy: true };
  const body = await res.text().catch(() => '');
  let message = '';
  try {
    message = String((JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '');
  } catch {
    /* no message */
  }
  return { ok: false, status: res.status, message: message.split(key).join('[key]') };
}

function httpProblem(status: number, who: string): Partial {
  if (status === 401 || status === 403) return { ok: false, status: 'invalid', detail: `${who} rejected the credentials (HTTP ${status}).` };
  if (status === 429) return { ok: false, status: 'error', detail: `${who} is rate limiting (HTTP 429). Try the check again shortly.` };
  return { ok: false, status: 'error', detail: `${who} answered HTTP ${status}.` };
}

async function checkGemini(e: EnvId): Promise<Partial> {
  const creds = geminiCredentials(e);
  if (!creds.length) return missing(e === 'temporary' ? 'GEMINI_API_KEY_TEMPORARY is' : e === 'secondary' ? 'GEMINI_API_KEY_SECONDARY is' : 'GEMINI_API_KEY is');
  const wanted = modelConfig().defaultModel.replace(/^gemini:/, '');
  const parts: string[] = [];
  let models = 0;
  for (const c of creds) {
    const res = await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': c.key });
    if (!res.ok) {
      const p = httpProblem(res.status, `Google (account ${c.id})`);
      return { ...p, detail: res.status === 400 ? `Google rejected the key of account ${c.id} (HTTP 400).` : p.detail, status: res.status === 400 ? 'invalid' : p.status };
    }
    const { models: list = [] } = (await res.json()) as { models?: { name: string }[] };
    const ids = list.map((m) => m.name.replace(/^models\//, ''));
    models = Math.max(models, ids.length);
    const probe = await geminiProbe(c.key);
    if (!probe.ok) {
      if (/free tier is not available|billing/i.test(probe.message))
        return { ok: false, status: 'invalid', detail: `The Google project of account ${c.id} has no Gemini free tier (Google asks for billing). Atlas AI only uses free tiers, so this key cannot be used.` };
      return httpProblem(probe.status, `Google (account ${c.id})`);
    }
    parts.push(`account ${c.id}: ${ids.length} models${ids.includes(wanted) ? `, ${wanted} offered` : `, ${wanted} NOT offered`}${probe.busy ? ', free requests used up for now' : ', test request answered'}`);
  }
  return { ok: true, status: 'healthy', detail: `Key accepted (${parts.join('; ')}).`, account: { accounts: creds.length, models } };
}

async function checkCloudflare(e: EnvId): Promise<Partial> {
  const creds = cloudflareCredentials(e);
  if (!creds.length) return missing(e === 'temporary' ? 'CLOUDFLARE_ACCOUNT_ID_TEMPORARY / CLOUDFLARE_API_TOKEN_TEMPORARY are' : e === 'secondary' ? 'The *_SECONDARY Cloudflare variables are' : 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are');
  for (const c of creds) {
    if (!/^[a-f0-9]{32}$/i.test(c.accountId)) return { ok: false, status: 'invalid', detail: `The Cloudflare account id of account ${c.id} is not a valid id.` };
    const res = await get(`https://api.cloudflare.com/client/v4/accounts/${c.accountId}/ai/models/search?per_page=1`, { authorization: `Bearer ${c.token}` });
    if (!res.ok) return httpProblem(res.status, `Cloudflare (account ${c.id})`);
  }
  return { ok: true, status: 'healthy', detail: `Token accepted with Workers AI access (${creds.map((c) => `account ${c.id}`).join(', ')}).`, account: { accounts: creds.length } };
}

async function checkOpenRouter(e: EnvId): Promise<Partial> {
  const key = apiKeyFor('openrouter', e);
  if (!key) return missing(e === 'temporary' ? 'OPENROUTER_API_KEY_TEMPORARY is' : 'OPENROUTER_API_KEY is');
  const res = await get('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${key}` });
  if (!res.ok) return httpProblem(res.status, 'OpenRouter');
  const { data } = (await res.json()) as {
    data?: { is_free_tier?: boolean; limit?: number | null; usage?: number; limit_remaining?: number | null; free_model_daily_requests?: { remaining?: number } };
  };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    ok: true,
    status: 'healthy',
    detail: `Key accepted (${data?.is_free_tier ? 'free tier' : 'account with purchased credits'}). Only free models are used.`,
    // never the key's label: OpenRouter labels can contain part of the key
    account: {
      freeTier: typeof data?.is_free_tier === 'boolean' ? data.is_free_tier : null,
      creditLimit: num(data?.limit),
      creditsUsed: num(data?.usage),
      creditsRemaining: num(data?.limit_remaining),
      freeRequestsLeftToday: num(data?.free_model_daily_requests?.remaining),
    },
  };
}

async function checkTavily(e: EnvId): Promise<Partial> {
  const key = apiKeyFor('tavily', e);
  if (!key) return missing(e === 'temporary' ? 'TAVILY_API_KEY_TEMPORARY is' : 'TAVILY_API_KEY is');
  const res = await get('https://api.tavily.com/usage', { authorization: `Bearer ${key}` }, SLOW_TIMEOUT);
  if (!res.ok) return httpProblem(res.status, 'Tavily');
  const d = (await res.json()) as { account?: { current_plan?: string; plan_usage?: number; plan_limit?: number } };
  return {
    ok: true,
    status: 'healthy',
    detail: `Key accepted (${d.account?.current_plan ?? 'plan not reported'}).`,
    account: { plan: d.account?.current_plan ?? null, monthlyLimit: d.account?.plan_limit ?? null, usedThisMonth: d.account?.plan_usage ?? null },
  };
}

async function checkSerpApi(e: EnvId): Promise<Partial> {
  const key = apiKeyFor('serpapi', e);
  if (!key) return missing(e === 'temporary' ? 'SERPAPI_API_KEY_TEMPORARY is' : 'SERPAPI_API_KEY is');
  // account.json is free (no search credit); the key is in the URL, so the URL is never logged
  const res = await get(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {});
  if (!res.ok) return httpProblem(res.status, 'SerpAPI');
  const d = (await res.json()) as { plan_name?: string; searches_per_month?: number; this_month_usage?: number; total_searches_left?: number };
  // only plan figures are kept (the response also holds the account email and the key itself)
  return {
    ok: true,
    status: 'healthy',
    detail: `Key accepted (${d.plan_name ?? 'plan not reported'}).`,
    account: { plan: d.plan_name ?? null, monthlyLimit: d.searches_per_month ?? null, usedThisMonth: d.this_month_usage ?? null, searchesLeft: d.total_searches_left ?? null },
  };
}

const CHECKS: Record<EnvProvider, (e: EnvId) => Promise<Partial>> = {
  gemini: checkGemini,
  cloudflare: checkCloudflare,
  openrouter: checkOpenRouter,
  tavily: checkTavily,
  serpapi: checkSerpApi,
};

/** Check one provider's credential set now; the result is stored (without secrets) for the dashboard. */
export async function checkHealth(p: EnvProvider, e: EnvId, now = Date.now()): Promise<HealthResult> {
  const started = Date.now();
  let r: Partial;
  try {
    r = await CHECKS[p](e);
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    r = { ok: false, status: 'error', detail: timeout ? 'The provider did not answer in time.' : 'The provider could not be reached.' };
  }
  const result: HealthResult = { ...r, checkedAt: now, ms: Date.now() - started };
  if (adminConfigured()) {
    await (await adminDb())
      .set(healthPath(p, e), { ...result, provider: p, environment: e, updatedAt: SERVER_TIME })
      .catch(() => undefined);
  }
  return result;
}

/** Stored results of earlier checks. */
export async function storedHealth(pairs: [EnvProvider, EnvId][]): Promise<Map<string, HealthResult>> {
  const out = new Map<string, HealthResult>();
  if (!adminConfigured()) return out;
  const db = await adminDb();
  const docs = await Promise.all(pairs.map(([p, e]) => db.get<HealthResult>(healthPath(p, e)).catch(() => null)));
  docs.forEach((d, i) => {
    if (d?.data) out.set(`${pairs[i][0]}_${pairs[i][1]}`, d.data);
  });
  return out;
}
