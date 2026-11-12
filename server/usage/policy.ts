/**
 * AI usage allowances: features, profiles, limits and reset periods (pure: no I/O).
 *
 * Every AI feature has its own daily and weekly allowance, so using up one feature never
 * blocks another. Allowances are counted in "units": most requests are 1 unit; heavier work
 * (a Deep Research report, a long voice reply, a long translation) counts a little more.
 * Periods start at a configurable time in a configurable time zone (default Africa/Accra),
 * computed from the zone's real offsets so daylight-saving changes are handled.
 *
 * These are individual allowances. The provider safeguards (Gemini, Cloudflare, OpenRouter
 * free models, Tavily, SerpAPI, ElevenLabs caps) are separate and apply to everyone,
 * including administrators and users with unlimited access.
 */

export const FEATURES = [
  'chat',
  'reasoning',
  'research',
  'documents',
  'images',
  'voice_input',
  'voice_output',
  'translation',
] as const;
export type FeatureId = (typeof FEATURES)[number];

export const FEATURE_INFO: Record<FeatureId, { label: string; unit: string; explain: string }> = {
  chat: { label: 'Chat', unit: 'message', explain: 'Each message you send counts 1.' },
  reasoning: { label: 'Advanced reasoning', unit: 'message', explain: 'Each message to a reasoning model counts 1.' },
  research: { label: 'Web research', unit: 'search', explain: 'A web search counts 1; a Deep Research report counts 3.' },
  documents: { label: 'Document analysis', unit: 'question', explain: 'Each question about your documents counts 1.' },
  images: { label: 'Image generation', unit: 'image', explain: 'Each image created or edited counts 1.' },
  voice_input: { label: 'Voice input', unit: 'recording', explain: 'Each recording turned into text counts 1.' },
  voice_output: { label: 'Voice generation', unit: 'reply', explain: 'Each spoken reply counts 1 per 1,000 characters.' },
  translation: { label: 'Translation', unit: 'translation', explain: 'Each translation counts 1 per 2,000 characters.' },
};

export interface PeriodLimit {
  /** units per day; null = no daily limit */
  daily: number | null;
  /** units per week; null = no weekly limit */
  weekly: number | null;
}
export type Limits = Record<FeatureId, PeriodLimit>;

export interface Profile {
  name: string;
  description: string;
  /** no individual limits (provider safeguards still apply) */
  unlimited?: boolean;
  limits: Limits;
  builtin?: boolean;
}

export interface ResetConfig {
  timezone: string;
  /** "HH:MM", 24-hour, local to the time zone */
  dailyTime: string;
  /** 0 = Sunday … 6 = Saturday */
  weeklyDay: number;
  weeklyTime: string;
}

export interface UsageConfig {
  /** master switch: off = no individual limits for anyone */
  enabled: boolean;
  features: Record<FeatureId, { enabled: boolean }>;
  reset: ResetConfig;
  defaultProfile: string;
  profiles: Record<string, Profile>;
}

/*
 * Starting limits (Standard). Chosen from the verified capacity of the connected accounts and
 * shared by all users; the provider safeguards stop any feature before a free quota is passed:
 * - chat: Gemini A + B free tier (Flash 20 requests/day each, Flash-Lite and OpenRouter free
 *   models behind them) - a generous personal share, not the whole pool
 * - research: Tavily 30/day and SerpAPI 8/day app caps (900 + 200 per month)
 * - images: the existing 10/day image allowance (Cloudflare A + B, 9,000 Neurons/day each)
 * - voice and translation: Cloudflare Neurons, with ElevenLabs on its own credit caps
 */
const L = (daily: number | null, weekly: number | null): PeriodLimit => ({ daily, weekly });
export const STANDARD_LIMITS: Limits = {
  chat: L(150, 700),
  reasoning: L(30, 150),
  research: L(15, 60),
  documents: L(40, 200),
  images: L(10, 40),
  voice_input: L(100, 500),
  voice_output: L(60, 300),
  translation: L(60, 300),
};

function scaled(base: Limits, factor: number): Limits {
  const out = {} as Limits;
  for (const f of FEATURES) {
    const b = base[f];
    out[f] = {
      daily: b.daily === null ? null : Math.max(1, Math.round(b.daily * factor)),
      weekly: b.weekly === null ? null : Math.max(1, Math.round(b.weekly * factor)),
    };
  }
  return out;
}

export const BUILTIN_PROFILES: Record<string, Profile> = {
  standard: { name: 'Standard', description: 'The default allowance for every approved account.', limits: STANDARD_LIMITS, builtin: true },
  premium: { name: 'Premium', description: 'Twice the Standard allowance.', limits: scaled(STANDARD_LIMITS, 2), builtin: true },
  restricted: { name: 'Restricted', description: 'A quarter of the Standard allowance.', limits: scaled(STANDARD_LIMITS, 0.25), builtin: true },
  unlimited: {
    name: 'Unlimited AI Access',
    description: 'No individual limits. Provider safeguards still apply.',
    unlimited: true,
    limits: STANDARD_LIMITS,
    builtin: true,
  },
  custom: { name: 'Custom', description: 'Limits set for one account.', limits: STANDARD_LIMITS, builtin: true },
};

export const DEFAULT_RESET: ResetConfig = { timezone: 'Africa/Accra', dailyTime: '00:00', weeklyDay: 1, weeklyTime: '00:00' };

export const DEFAULT_USAGE_CONFIG: UsageConfig = {
  enabled: true,
  features: Object.fromEntries(FEATURES.map((f) => [f, { enabled: true }])) as UsageConfig['features'],
  reset: DEFAULT_RESET,
  defaultProfile: 'standard',
  profiles: BUILTIN_PROFILES,
};

export const MAX_LIMIT = 100_000;
export const PROFILE_ID = /^[a-z][a-z0-9_]{1,30}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function limitValue(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(0, Math.floor(v)));
}

export function normalizeLimits(raw: unknown, base: Limits = STANDARD_LIMITS): Limits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Partial<PeriodLimit> | undefined>;
  const out = {} as Limits;
  for (const f of FEATURES) {
    const v = r[f] ?? {};
    out[f] = { daily: limitValue(v.daily, base[f].daily), weekly: limitValue(v.weekly, base[f].weekly) };
  }
  return out;
}

/** Partial limits (custom limits and overrides): only the features and periods that were set. */
export function normalizePartialLimits(raw: unknown): Partial<Record<FeatureId, Partial<PeriodLimit>>> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Partial<PeriodLimit> | undefined>;
  const out: Partial<Record<FeatureId, Partial<PeriodLimit>>> = {};
  for (const f of FEATURES) {
    const v = r[f];
    if (!v || typeof v !== 'object') continue;
    const e: Partial<PeriodLimit> = {};
    if ('daily' in v) e.daily = limitValue(v.daily, null);
    if ('weekly' in v) e.weekly = limitValue(v.weekly, null);
    if (Object.keys(e).length) out[f] = e;
  }
  return out;
}

export function normalizeUsageConfig(raw: unknown): UsageConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageConfig> & Record<string, unknown>;
  const features = {} as UsageConfig['features'];
  const rf = (r.features ?? {}) as Record<string, { enabled?: unknown } | undefined>;
  for (const f of FEATURES) features[f] = { enabled: rf[f]?.enabled !== false };
  const rr = (r.reset ?? {}) as Partial<ResetConfig>;
  const reset: ResetConfig = {
    timezone: validTimeZone(rr.timezone) ? rr.timezone : DEFAULT_RESET.timezone,
    dailyTime: typeof rr.dailyTime === 'string' && TIME.test(rr.dailyTime) ? rr.dailyTime : DEFAULT_RESET.dailyTime,
    weeklyDay: Number.isInteger(rr.weeklyDay) && rr.weeklyDay! >= 0 && rr.weeklyDay! <= 6 ? rr.weeklyDay! : DEFAULT_RESET.weeklyDay,
    weeklyTime: typeof rr.weeklyTime === 'string' && TIME.test(rr.weeklyTime) ? rr.weeklyTime : DEFAULT_RESET.weeklyTime,
  };
  const profiles: Record<string, Profile> = {};
  const rp = (r.profiles ?? {}) as Record<string, Partial<Profile> | undefined>;
  for (const [id, b] of Object.entries(BUILTIN_PROFILES)) {
    const saved = rp[id];
    profiles[id] = {
      ...b,
      // built-in names stay; their limits can be changed (except Unlimited, which has none)
      limits: saved?.limits ? normalizeLimits(saved.limits, b.limits) : b.limits,
      description: typeof saved?.description === 'string' ? saved.description.slice(0, 200) : b.description,
    };
  }
  for (const [id, p] of Object.entries(rp)) {
    if (!p || id in BUILTIN_PROFILES || !PROFILE_ID.test(id)) continue;
    profiles[id] = {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : id,
      description: typeof p.description === 'string' ? p.description.slice(0, 200) : '',
      limits: normalizeLimits(p.limits),
    };
  }
  const defaultProfile = typeof r.defaultProfile === 'string' && profiles[r.defaultProfile] && !profiles[r.defaultProfile].unlimited ? r.defaultProfile : 'standard';
  return { enabled: r.enabled !== false, features, reset, defaultProfile, profiles };
}

/* ---------------------------------------------------------------- costs */

export interface CostDetail {
  deepResearch?: boolean;
  chars?: number;
}

/** Units a request counts. Simple for users: most requests are 1. */
export function costOf(feature: FeatureId, d: CostDetail = {}): number {
  if (feature === 'research') return d.deepResearch ? 3 : 1;
  if (feature === 'voice_output') return Math.max(1, Math.ceil((d.chars ?? 0) / 1000));
  if (feature === 'translation') return Math.max(1, Math.ceil((d.chars ?? 0) / 2000));
  return 1;
}

/* ---------------------------------------------------------------- periods (time-zone aware) */

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}
function zoneParts(ms: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute };
}
/** offset of the zone from UTC at an instant, in ms */
function offsetAt(ms: number, tz: string): number {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
}
/** The instant a local wall-clock time occurs in the zone (a time skipped by DST moves forward). */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const first = wall - offsetAt(wall, tz);
  const second = wall - offsetAt(first, tz);
  if (first === second) return first;
  // the offset changed between the guesses: the wall time is in a DST gap or overlap
  const p = zoneParts(second, tz);
  if (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) === wall) return second;
  return Math.max(first, second);
}

function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const pad = (n: number) => String(n).padStart(2, '0');
const hm = (s: string) => s.split(':').map(Number) as [number, number];

export interface Period {
  /** stable id of the period: the local date it started */
  key: string;
  start: number;
  /** when the next period starts (the reset time) */
  end: number;
}

export function dailyPeriod(now: number, r: ResetConfig): Period {
  const [h, mi] = hm(r.dailyTime);
  const p = zoneParts(now, r.timezone);
  let day = { y: p.y, m: p.m, d: p.d };
  let start = zonedTime(day.y, day.m, day.d, h, mi, r.timezone);
  if (start > now) {
    day = addDays(day.y, day.m, day.d, -1);
    start = zonedTime(day.y, day.m, day.d, h, mi, r.timezone);
  }
  const next = addDays(day.y, day.m, day.d, 1);
  return { key: `${day.y}-${pad(day.m)}-${pad(day.d)}`, start, end: zonedTime(next.y, next.m, next.d, h, mi, r.timezone) };
}

export function weeklyPeriod(now: number, r: ResetConfig): Period {
  const [h, mi] = hm(r.weeklyTime);
  const p = zoneParts(now, r.timezone);
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  let day = addDays(p.y, p.m, p.d, -((weekday - r.weeklyDay + 7) % 7));
  let start = zonedTime(day.y, day.m, day.d, h, mi, r.timezone);
  if (start > now) {
    day = addDays(day.y, day.m, day.d, -7);
    start = zonedTime(day.y, day.m, day.d, h, mi, r.timezone);
  }
  const next = addDays(day.y, day.m, day.d, 7);
  return { key: `${day.y}-${pad(day.m)}-${pad(day.d)}`, start, end: zonedTime(next.y, next.m, next.d, h, mi, r.timezone) };
}

/* ---------------------------------------------------------------- accounts and effective limits */

export interface UnlimitedGrant {
  /** permanent, or until a time (a duration is stored as its end time) */
  until: number | null;
  previousProfile: string;
  grantedBy: string;
  grantedAt: number;
  reason?: string | null;
}

export interface Override {
  limits: Partial<Record<FeatureId, Partial<PeriodLimit>>>;
  until: number | null;
  reason?: string | null;
}

/** counters for one feature in the current periods */
export interface Counter {
  d: string;
  du: number;
  w: string;
  wu: number;
}

/** usageAccounts/{uid}: written only by the server; the owner and administrators can read it */
export interface UsageAccount {
  profile?: string | null;
  customLimits?: Partial<Record<FeatureId, Partial<PeriodLimit>>> | null;
  override?: Override | null;
  unlimited?: UnlimitedGrant | null;
  counters?: Partial<Record<FeatureId, Counter>>;
}

export type UnlimitedSource = 'admin' | 'grant' | 'profile' | null;

export interface Effective {
  profileId: string;
  profileName: string;
  unlimited: UnlimitedSource;
  unlimitedUntil: number | null;
  limits: Limits;
  /** the temporary grant ended and should be cleared (previous profile restored) */
  grantExpired: boolean;
}

export function grantActive(g: UnlimitedGrant | null | undefined, now: number): boolean {
  return Boolean(g && (g.until === null || g.until > now));
}

export function effectiveLimits(cfg: UsageConfig, acct: UsageAccount | null | undefined, isAdmin: boolean, now: number): Effective {
  const profileId = acct?.profile && cfg.profiles[acct.profile] ? acct.profile : cfg.defaultProfile;
  const profile = cfg.profiles[profileId] ?? BUILTIN_PROFILES.standard;
  const limits = {} as Limits;
  const custom = acct?.customLimits ?? {};
  const ov = acct?.override && (acct.override.until === null || acct.override.until > now) ? acct.override.limits : {};
  for (const f of FEATURES) limits[f] = { ...profile.limits[f], ...(custom[f] ?? {}), ...(ov[f] ?? {}) };
  const grant = acct?.unlimited;
  const active = grantActive(grant, now);
  const unlimited: UnlimitedSource = isAdmin ? 'admin' : active ? 'grant' : profile.unlimited ? 'profile' : null;
  return {
    profileId,
    profileName: profile.name,
    unlimited,
    unlimitedUntil: unlimited === 'grant' ? (grant?.until ?? null) : null,
    limits,
    grantExpired: Boolean(grant) && !active,
  };
}

/* ---------------------------------------------------------------- decisions and snapshots */

export interface PeriodView {
  used: number;
  limit: number | null;
  remaining: number | null;
  resetsAt: number;
  key: string;
}

export interface FeatureView {
  id: FeatureId;
  label: string;
  explain: string;
  /** individual limits apply to this feature */
  limited: boolean;
  daily: PeriodView;
  weekly: PeriodView;
  /** the higher share used of the two periods, 0-100 (null when not limited) */
  percent: number | null;
  /** the period that runs out first */
  binding: 'daily' | 'weekly' | null;
  exhausted: boolean;
}

export function usedNow(c: Counter | undefined, day: Period, week: Period) {
  return { du: c && c.d === day.key ? c.du : 0, wu: c && c.w === week.key ? c.wu : 0 };
}

export function featureView(f: FeatureId, cfg: UsageConfig, eff: Effective, c: Counter | undefined, now: number): FeatureView {
  const day = dailyPeriod(now, cfg.reset);
  const week = weeklyPeriod(now, cfg.reset);
  const { du, wu } = usedNow(c, day, week);
  const limited = cfg.enabled && cfg.features[f].enabled && !eff.unlimited;
  const lim = eff.limits[f];
  const dl = limited ? lim.daily : null;
  const wl = limited ? lim.weekly : null;
  const share = (u: number, l: number | null) => (l === null ? null : l === 0 ? 100 : Math.min(100, (u / l) * 100));
  const ds = share(du, dl);
  const ws = share(wu, wl);
  let binding: FeatureView['binding'] = null;
  if (ds !== null || ws !== null) binding = (ws ?? -1) > (ds ?? -1) ? 'weekly' : 'daily';
  const percent = ds === null && ws === null ? null : Math.max(ds ?? 0, ws ?? 0);
  return {
    id: f,
    label: FEATURE_INFO[f].label,
    explain: FEATURE_INFO[f].explain,
    limited: dl !== null || wl !== null,
    daily: { used: du, limit: dl, remaining: dl === null ? null : Math.max(0, dl - du), resetsAt: day.end, key: day.key },
    weekly: { used: wu, limit: wl, remaining: wl === null ? null : Math.max(0, wl - wu), resetsAt: week.end, key: week.key },
    percent: percent === null ? null : Math.round(percent * 10) / 10,
    binding,
    exhausted: (dl !== null && du >= dl) || (wl !== null && wu >= wl),
  };
}

export type Decision =
  | { ok: true; counter: Counter }
  | { ok: false; period: 'daily' | 'weekly'; used: number; limit: number; resetsAt: number };

/** Whether `cost` more units fit; the new counter if they do. */
export function decide(f: FeatureId, cost: number, cfg: UsageConfig, eff: Effective, c: Counter | undefined, now: number): Decision {
  const day = dailyPeriod(now, cfg.reset);
  const week = weeklyPeriod(now, cfg.reset);
  const { du, wu } = usedNow(c, day, week);
  const limited = cfg.enabled && cfg.features[f].enabled && !eff.unlimited;
  if (limited) {
    const { daily, weekly } = eff.limits[f];
    // a request that starts with something left is allowed to finish, even if it is heavier
    // than what is left (an accepted request is never cut short); the period is then used up
    if (daily !== null && du >= daily) return { ok: false, period: 'daily', used: du, limit: daily, resetsAt: day.end };
    if (weekly !== null && wu >= weekly) return { ok: false, period: 'weekly', used: wu, limit: weekly, resetsAt: week.end };
  }
  return { ok: true, counter: { d: day.key, du: du + cost, w: week.key, wu: wu + cost } };
}

export function refusalMessage(f: FeatureId, period: 'daily' | 'weekly', resetsAt: number, tz: string): string {
  const when = formatReset(resetsAt, tz);
  const label = FEATURE_INFO[f].label;
  return `You have used your ${period} ${label.toLowerCase()} allowance. It resets ${when}. Other features are still available.`;
}

/** "at 00:00 on Fri 13 Nov (Africa/Accra)" */
export function formatReset(at: number, tz: string): string {
  const d = new Date(at);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `at ${time} on ${day} (${tz})`;
}
