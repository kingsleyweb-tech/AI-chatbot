/**
 * API Environment Manager: which credential set (Main, Secondary, Temporary) each provider uses.
 *
 * - The choice lives in `config/environments` (server-only in the Firestore rules; it holds no
 *   secrets, only environment names). Secrets stay in server environment variables (env.ts).
 * - Every API request pins the configuration when it starts (`handle()` in http.ts runs the
 *   handler inside `runPinned`). Everything the request does, including background work it starts,
 *   reads the pinned copy, so a switch never changes or interrupts a request already running and a
 *   request never mixes credentials from two versions.
 * - No silent fallback: a provider whose environment is switched off, missing credentials or over
 *   the Temporary ceiling is unavailable; it is never served with another environment's keys.
 * - ElevenLabs is not part of any of this (one shared integration in every environment).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adminConfigured, adminDb } from '../admin.js';
import { env } from '../env.js';
import { fieldPath, SERVER_TIME } from '../firestore.js';
import { ProviderError } from '../providers/types.js';
import {
  defaultEnvironmentConfig,
  ENV_LABEL,
  normalizeEnvironmentConfig,
  PROVIDER_LABEL,
  type EnvId,
  type EnvironmentConfig,
  type EnvProvider,
} from '../shared/environments.js';

export const ENV_CONFIG_PATH = 'config/environments';

/* ----------------------------------- credentials ----------------------------------- */

export type GeminiCredential = { id: 'A' | 'B' | 'T'; key: string };
export type CloudflareCredential = { id: 'A' | 'B' | 'T'; accountId: string; token: string };

/** Gemini keys of an environment: Main pools A and B (today's behaviour), Secondary is B, Temporary is T. */
export function geminiCredentials(e: EnvId): GeminiCredential[] {
  const v = env();
  const a = v.geminiKey ? [{ id: 'A' as const, key: v.geminiKey }] : [];
  const b = v.geminiKeySecondary && v.geminiKeySecondary !== v.geminiKey ? [{ id: 'B' as const, key: v.geminiKeySecondary }] : [];
  if (e === 'main') return [...a, ...b];
  if (e === 'secondary') return v.geminiKeySecondary ? [{ id: 'B', key: v.geminiKeySecondary }] : [];
  return v.geminiKeyTemporary ? [{ id: 'T', key: v.geminiKeyTemporary }] : [];
}

/** Cloudflare accounts of an environment (same pattern as Gemini). */
export function cloudflareCredentials(e: EnvId): CloudflareCredential[] {
  const v = env();
  const a = v.cloudflareAccountId && v.cloudflareApiToken ? [{ id: 'A' as const, accountId: v.cloudflareAccountId, token: v.cloudflareApiToken }] : [];
  const bOk = Boolean(v.cloudflareAccountIdSecondary && v.cloudflareApiTokenSecondary);
  const b = bOk ? [{ id: 'B' as const, accountId: v.cloudflareAccountIdSecondary, token: v.cloudflareApiTokenSecondary }] : [];
  if (e === 'main') return [...a, ...b.filter((x) => x.accountId !== v.cloudflareAccountId)];
  if (e === 'secondary') return b;
  return v.cloudflareAccountIdTemporary && v.cloudflareApiTokenTemporary
    ? [{ id: 'T', accountId: v.cloudflareAccountIdTemporary, token: v.cloudflareApiTokenTemporary }]
    : [];
}

/** The single key of OpenRouter, Tavily or SerpAPI in an environment ('' when not set or not offered). */
export function apiKeyFor(p: 'openrouter' | 'tavily' | 'serpapi', e: EnvId): string {
  const v = env();
  if (e === 'secondary') return '';
  const temp = e === 'temporary';
  if (p === 'openrouter') return (temp ? v.openRouterKeyTemporary : v.openRouterKey).trim();
  if (p === 'tavily') return (temp ? v.tavilyKeyTemporary : v.tavilyKey).trim();
  return (temp ? v.serpApiKeyTemporary : v.serpApiKey).trim();
}

/** Server variable names behind each credential set (names only; values are never read out). */
export const CREDENTIAL_VARIABLES: Record<EnvProvider, Partial<Record<EnvId, string[]>>> = {
  gemini: {
    main: ['GEMINI_API_KEY', 'GEMINI_API_KEY_SECONDARY'],
    secondary: ['GEMINI_API_KEY_SECONDARY'],
    temporary: ['GEMINI_API_KEY_TEMPORARY'],
  },
  cloudflare: {
    main: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID_SECONDARY', 'CLOUDFLARE_API_TOKEN_SECONDARY'],
    secondary: ['CLOUDFLARE_ACCOUNT_ID_SECONDARY', 'CLOUDFLARE_API_TOKEN_SECONDARY'],
    temporary: ['CLOUDFLARE_ACCOUNT_ID_TEMPORARY', 'CLOUDFLARE_API_TOKEN_TEMPORARY'],
  },
  openrouter: { main: ['OPENROUTER_API_KEY'], temporary: ['OPENROUTER_API_KEY_TEMPORARY'] },
  tavily: { main: ['TAVILY_API_KEY'], temporary: ['TAVILY_API_KEY_TEMPORARY'] },
  serpapi: { main: ['SERPAPI_API_KEY'], temporary: ['SERPAPI_API_KEY_TEMPORARY'] },
};

/** Optional variables: Main works with only account A configured. */
const OPTIONAL = new Set(['GEMINI_API_KEY_SECONDARY', 'CLOUDFLARE_ACCOUNT_ID_SECONDARY', 'CLOUDFLARE_API_TOKEN_SECONDARY']);

function variableSet(name: string): boolean {
  const e = process.env;
  const aliases: Record<string, string[]> = {
    GEMINI_API_KEY: ['GEMINI_API_KEY', 'GEMINI_API_KEY_PRIMARY'],
    CLOUDFLARE_ACCOUNT_ID: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID_PRIMARY'],
    CLOUDFLARE_API_TOKEN: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN_PRIMARY'],
  };
  return (aliases[name] ?? [name]).some((n) => Boolean(e[n]?.trim()));
}

export function credentialVariables(p: EnvProvider, e: EnvId): { name: string; set: boolean; optional: boolean }[] {
  const names = CREDENTIAL_VARIABLES[p][e] ?? [];
  if (p !== 'gemini' && p !== 'cloudflare') return names.map((name) => ({ name, set: variableSet(name), optional: false }));
  // Secondary: B is required there; Main: B is optional
  return names.map((name) => ({ name, set: variableSet(name), optional: e === 'main' && OPTIONAL.has(name) }));
}

/** Credentials exist for this provider and environment. */
export function credentialsConfigured(p: EnvProvider, e: EnvId): boolean {
  if (p === 'gemini') return geminiCredentials(e).length > 0;
  if (p === 'cloudflare') return cloudflareCredentials(e).length > 0;
  return Boolean(apiKeyFor(p, e));
}

/** A fingerprint to compare credential sets without ever exposing them (in memory only). */
function identity(p: EnvProvider, e: EnvId): string[] {
  if (p === 'gemini') return geminiCredentials(e).map((c) => c.key);
  if (p === 'cloudflare') return cloudflareCredentials(e).map((c) => c.accountId);
  const k = apiKeyFor(p, e);
  return k ? [k] : [];
}

/** Other environments using any of the same keys/accounts as this one (so no separate capacity). */
export function sharedCredentials(p: EnvProvider, e: EnvId, among: readonly EnvId[]): EnvId[] {
  const mine = new Set(identity(p, e));
  if (!mine.size) return [];
  // Main deliberately contains Secondary's account B: that overlap is by design, not a duplicate
  const designed = (x: EnvId) => (e === 'main' && x === 'secondary') || (e === 'secondary' && x === 'main');
  return among.filter((x) => x !== e && !designed(x) && identity(p, x).some((id) => mine.has(id)));
}

/* ------------------------------------ the config ------------------------------------ */

const TTL = 15_000;
let cache: { value: EnvironmentConfig; at: number } | null = null;

/** The stored configuration (cached for 15 s per server instance). Defaults when no store exists. */
export async function loadEnvironmentConfig(fresh = false): Promise<EnvironmentConfig> {
  if (!adminConfigured()) return cache?.value ?? defaultEnvironmentConfig();
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  const doc = await (await adminDb()).get<Record<string, unknown>>(ENV_CONFIG_PATH);
  const value = normalizeEnvironmentConfig(doc?.data);
  cache = { value, at: Date.now() };
  return value;
}

/** for tests and right after an administrator's change */
export function setEnvironmentCache(value: EnvironmentConfig | null) {
  cache = value ? { value, at: Date.now() } : null;
}

/* --------------------------------- request pinning --------------------------------- */

export interface Pin {
  config: EnvironmentConfig;
  /** the environment whose user usage limits apply (the global environment) */
  usageEnv: EnvId;
  /** the configuration could not be read: providers refuse instead of guessing an environment */
  unavailable?: boolean;
}

const store = new AsyncLocalStorage<Pin>();

/** The configuration a new request runs with. */
export async function requestPin(): Promise<Pin> {
  try {
    const config = await loadEnvironmentConfig();
    return { config, usageEnv: config.global };
  } catch (err) {
    // a recent copy is kept and still valid; without one, refuse provider calls rather than guess
    if (cache) return { config: cache.value, usageEnv: cache.value.global };
    console.error('[environments] configuration unavailable:', err instanceof Error ? err.message : 'unknown error');
    const config = defaultEnvironmentConfig();
    return { config, usageEnv: config.global, unavailable: true };
  }
}

export function runPinned<T>(pin: Pin, fn: () => T): T {
  return store.run(pin, fn);
}

/** The pinned configuration (outside a request, e.g. unit tests: the last loaded, else the defaults). */
export function currentPin(): Pin {
  const got = store.getStore();
  if (got) return got;
  const config = cache?.value ?? defaultEnvironmentConfig();
  return { config, usageEnv: config.global };
}

/** Run with a different usage environment (an administrator managing that environment's limits). */
export function withUsageEnvironment<T>(usageEnv: EnvId, fn: () => T): T {
  return store.run({ ...currentPin(), usageEnv }, fn);
}

/** The environment a provider uses for the current request. */
export function envOf(p: EnvProvider): EnvId {
  const pin = currentPin();
  if (pin.unavailable) throw new ProviderError('not_configured', 'The API environment settings could not be loaded. Please try again shortly.', 503);
  return pin.config.providers[p];
}

/** The usage-limit environment of the current request. */
export function usageEnv(): EnvId {
  return currentPin().usageEnv;
}

export function environmentDisabled(p: EnvProvider, e: EnvId = envOf(p)): boolean {
  return currentPin().config.disabled[p].includes(e);
}

/** The provider can be used in its current environment (credentials present, not switched off). */
export function providerAvailable(p: EnvProvider): boolean {
  try {
    const e = envOf(p);
    return !environmentDisabled(p, e) && credentialsConfigured(p, e);
  } catch {
    return false;
  }
}

/**
 * A model fallback chain limited to the API environment of its first model's provider, without
 * providers switched off there. Throws a clear, recoverable error when nothing is left.
 */
export function sameEnvironmentChain(chain: string[], providerOf: (id: string) => EnvProvider): string[] {
  if (!chain.length) return chain;
  const e = envOf(providerOf(chain[0]));
  const out = chain.filter((id) => {
    const p = providerOf(id);
    return envOf(p) === e && !environmentDisabled(p, e);
  });
  if (!out.length)
    throw new ProviderError('not_configured', `No AI model is available in the ${ENV_LABEL[e]} environment right now. Please try again later.`, 503);
  return out;
}

/** Short key for in-memory health state, so a failure in one environment never rests another's. */
export function envScopedKey(p: EnvProvider, key: string): string {
  let e: EnvId = 'main';
  try {
    e = envOf(p);
  } catch {
    // unavailable: the provider refuses anyway
  }
  return e === 'main' ? key : `${e}|${key}`;
}

/* ------------------------- request counting and the ceiling ------------------------- */

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const utcMonth = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
/** ISO week (Monday start, UTC), e.g. 2026-W46 */
export function isoWeek(now = Date.now()): string {
  const d = new Date(now);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const envUsagePath = (e: EnvId, period: 'd' | 'w' | 'm', key: string) => `envUsage/${e}_${period}_${key}`;

export class EnvironmentLimitError extends ProviderError {
  constructor(message: string) {
    super('environment_limit', message, 429);
  }
}

export function ceilingMessage(period: 'daily' | 'weekly'): string {
  return `The ${ENV_LABEL.temporary} environment has reached its ${period} request ceiling. Please try again later.`;
}

/**
 * Count one request to a provider in its current environment. On Temporary credentials the
 * request is counted atomically against the daily and weekly ceilings first and refused (nothing
 * is sent) when either is reached. Main and Secondary are counted without delaying the request.
 * Throws when the provider is switched off in this environment.
 */
export async function chargeProviderRequest(p: EnvProvider, now = Date.now()): Promise<void> {
  const e = envOf(p);
  if (environmentDisabled(p, e))
    throw new ProviderError('not_configured', `${PROVIDER_LABEL[p]} is switched off in the ${ENV_LABEL[e]} environment.`, 503);
  if (!adminConfigured()) return;
  const day = utcDay(now);
  const week = isoWeek(now);
  const month = utcMonth(now);
  const field = fieldPath(p, 'requests');
  let db;
  try {
    db = await adminDb();
  } catch {
    if (e === 'temporary') throw new EnvironmentLimitError(`The ${ENV_LABEL.temporary} environment cannot check its request ceiling right now. Please try again shortly.`);
    return;
  }
  const meta = (key: string) => ({ environment: e, period: key, updatedAt: SERVER_TIME });
  if (e !== 'temporary') {
    void db
      .commit([
        { op: 'increment', path: envUsagePath(e, 'd', day), data: meta(day), increments: { total: 1, [field]: 1 } },
        { op: 'increment', path: envUsagePath(e, 'w', week), data: meta(week), increments: { total: 1, [field]: 1 } },
        { op: 'increment', path: envUsagePath(e, 'm', month), data: meta(month), increments: { total: 1, [field]: 1 } },
      ])
      .catch(() => undefined);
    return;
  }
  const ceiling = currentPin().config.temporaryCeiling;
  let dayN: number;
  let weekN: number;
  try {
    [dayN, weekN] = await Promise.all([
      db.incrementAndGet(envUsagePath(e, 'd', day), { total: 1, [field]: 1 }, meta(day)).then((r) => r.total),
      db.incrementAndGet(envUsagePath(e, 'w', week), { total: 1, [field]: 1 }, meta(week)).then((r) => r.total),
    ]);
  } catch {
    // fail closed: the ceiling protects the temporary credentials
    throw new EnvironmentLimitError(`The ${ENV_LABEL.temporary} environment cannot check its request ceiling right now. Please try again shortly.`);
  }
  if (dayN > ceiling.daily || weekN > ceiling.weekly) {
    // not sent: give the counts back and note the refusal
    void db
      .commit([
        { op: 'increment', path: envUsagePath(e, 'd', day), increments: { total: -1, [field]: -1, refused: 1 } },
        { op: 'increment', path: envUsagePath(e, 'w', week), increments: { total: -1, [field]: -1, refused: 1 } },
      ])
      .catch(() => undefined);
    throw new EnvironmentLimitError(ceilingMessage(dayN > ceiling.daily ? 'daily' : 'weekly'));
  }
  void db.commit([{ op: 'increment', path: envUsagePath(e, 'm', month), data: meta(month), increments: { total: 1, [field]: 1 } }]).catch(() => undefined);
}
