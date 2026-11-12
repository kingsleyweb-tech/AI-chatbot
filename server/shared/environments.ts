/**
 * API environments (shared by the server and the admin dashboard; pure, no secrets).
 *
 * Each external AI/search provider can run on one of its credential sets:
 *  - main       today's production credentials (Gemini and Cloudflare: accounts A and B pooled)
 *  - secondary  the secondary set only (Gemini and Cloudflare account B)
 *  - temporary  the separate public-testing credentials (fully isolated, with a request ceiling)
 * OpenRouter, Tavily and SerpAPI have no secondary set. ElevenLabs is not part of this at all:
 * it is one shared integration in every environment.
 */
export const ENVIRONMENTS = ['main', 'secondary', 'temporary'] as const;
export type EnvId = (typeof ENVIRONMENTS)[number];

export const ENV_PROVIDERS = ['gemini', 'cloudflare', 'openrouter', 'tavily', 'serpapi'] as const;
export type EnvProvider = (typeof ENV_PROVIDERS)[number];

/** Credential sets that exist for each provider. */
export const SUPPORTED_ENVIRONMENTS: Record<EnvProvider, readonly EnvId[]> = {
  gemini: ENVIRONMENTS,
  cloudflare: ENVIRONMENTS,
  openrouter: ['main', 'temporary'],
  tavily: ['main', 'temporary'],
  serpapi: ['main', 'temporary'],
};

export const ENV_LABEL: Record<EnvId, string> = {
  main: 'Main',
  secondary: 'Secondary',
  temporary: 'Temporary Public Testing',
};

export const PROVIDER_LABEL: Record<EnvProvider, string> = {
  gemini: 'Google Gemini',
  cloudflare: 'Cloudflare Workers AI',
  openrouter: 'OpenRouter',
  tavily: 'Tavily',
  serpapi: 'SerpAPI',
};

export const supports = (p: EnvProvider, e: EnvId) => SUPPORTED_ENVIRONMENTS[p].includes(e);

export interface TemporaryCeiling {
  /** provider requests per day (UTC) on Temporary credentials, all providers together; 0 blocks them */
  daily: number;
  /** provider requests per ISO week (UTC, Monday start) */
  weekly: number;
}

export interface EnvironmentConfig {
  /** increases with every change; each request keeps the version it started with */
  version: number;
  /** the environment last chosen for everything; user usage limits follow it */
  global: EnvId;
  /** the environment each provider uses now */
  providers: Record<EnvProvider, EnvId>;
  /** emergency stop: provider environments that may not be used */
  disabled: Record<EnvProvider, EnvId[]>;
  temporaryCeiling: TemporaryCeiling;
  updatedAt: number | null;
  updatedBy: string | null;
}

export const DEFAULT_CEILING: TemporaryCeiling = { daily: 300, weekly: 1500 };
export const MAX_CEILING = 100_000;

export function defaultEnvironmentConfig(): EnvironmentConfig {
  return {
    version: 0,
    global: 'main',
    providers: { gemini: 'main', cloudflare: 'main', openrouter: 'main', tavily: 'main', serpapi: 'main' },
    disabled: { gemini: [], cloudflare: [], openrouter: [], tavily: [], serpapi: [] },
    temporaryCeiling: { ...DEFAULT_CEILING },
    updatedAt: null,
    updatedBy: null,
  };
}

const isEnv = (v: unknown): v is EnvId => typeof v === 'string' && (ENVIRONMENTS as readonly string[]).includes(v);
const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_CEILING, Math.max(0, Math.round(v))) : d);
const time = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

/** A stored config made safe: unknown values become the defaults, unsupported choices are refused. */
export function normalizeEnvironmentConfig(raw: unknown): EnvironmentConfig {
  const d = defaultEnvironmentConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const rp = (r.providers ?? {}) as Record<string, unknown>;
  const rd = (r.disabled ?? {}) as Record<string, unknown>;
  const rc = (r.temporaryCeiling ?? {}) as Record<string, unknown>;
  const providers = { ...d.providers };
  const disabled = { ...d.disabled };
  for (const p of ENV_PROVIDERS) {
    const v = rp[p];
    if (isEnv(v) && supports(p, v)) providers[p] = v;
    const list = Array.isArray(rd[p]) ? (rd[p] as unknown[]) : [];
    disabled[p] = ENVIRONMENTS.filter((e) => list.includes(e) && supports(p, e));
  }
  return {
    version: typeof r.version === 'number' && Number.isFinite(r.version) ? Math.max(0, Math.floor(r.version)) : 0,
    global: isEnv(r.global) ? r.global : 'main',
    providers,
    disabled,
    temporaryCeiling: { daily: int(rc.daily, d.temporaryCeiling.daily), weekly: int(rc.weekly, d.temporaryCeiling.weekly) },
    updatedAt: time(r.updatedAt),
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy.slice(0, 320) : null,
  };
}

/** The environment a provider takes when everything is switched to `target` (Main when it has no such set). */
export function globalTarget(p: EnvProvider, target: EnvId): EnvId {
  return supports(p, target) ? target : 'main';
}

/** "main", "temporary" ... or "mixed" when providers differ. */
export function overallEnvironment(cfg: Pick<EnvironmentConfig, 'providers'>): EnvId | 'mixed' {
  const set = new Set(ENV_PROVIDERS.map((p) => cfg.providers[p]));
  return set.size === 1 ? [...set][0] : 'mixed';
}

/* ------------------------------ admin dashboard views ------------------------------ */

export interface CredentialView {
  provider: EnvProvider;
  environment: EnvId;
  /** server variable names (never values) and whether each is set */
  variables: { name: string; set: boolean }[];
  configured: boolean;
  /** the same key/account as another environment's (no separate capacity) */
  sharedWith: EnvId[];
  disabled: boolean;
  health: HealthResult | null;
}

export interface HealthResult {
  ok: boolean;
  status: 'healthy' | 'missing' | 'invalid' | 'error';
  /** short, secret-free description */
  detail: string;
  checkedAt: number;
  ms: number;
  /** what the provider itself reported (plan, quota) when it says */
  account?: Record<string, string | number | boolean | null>;
}

export interface EnvironmentUsageRow {
  environment: EnvId;
  provider: EnvProvider;
  /** requests counted by Atlas AI (app-estimated) */
  today: number;
  week: number;
  month: number;
}
