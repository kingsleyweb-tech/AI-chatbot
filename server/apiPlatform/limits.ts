/**
 * Usage limits of connected applications: request rates, feature quotas, concurrency and
 * idempotency. Completely separate from the website's per-person allowances (server/usage): an
 * application never uses, sees or changes a person's allowance, and a person never uses an
 * application's.
 *
 * Every counter is a Firestore field increment (atomic on the server, safe across function
 * instances). The new value comes back with the write, so the check is made after the increment:
 * two simultaneous requests can never both take the last unit. A request that went over is rolled
 * back straight away and refused with HTTP 429.
 *
 * Application limits and key limits are independent: the application's counter is checked against
 * the application's limit and the key's counter against the key's own limit (if it has one).
 *
 * Writes are kept low for the free Firestore plan: the day and month counters share one write
 * each, minute and hour counters share one document (only written when such a limit is set), and
 * week counters are only written when a weekly limit is set.
 */
import { HttpError } from '../http.js';
import type { Firestore } from '../firestore.js';
import { isoWeek, utcDay, utcMonth } from '../environments/index.js';
import { HARD_CEILINGS, type IntegrationConfig, type NumericLimitKey } from '../shared/apiPlatform.js';
import type { KeyRecord } from './store.js';
import { shortHash } from './keys.js';

export const STATS = 'apiStats';
export const RATE = 'apiRate';
export const CONC = 'apiConc';
export const IDEM = 'apiIdem';

export const dayStatsPath = (day: string) => `${STATS}/d-${day}`;
export const weekStatsPath = (week: string) => `${STATS}/w-${week}`;
export const monthStatsPath = (month: string) => `${STATS}/m-${month}`;

export interface Scope {
  integration: IntegrationConfig;
  key: KeyRecord;
}

/** The binding request window, for the X-RateLimit-* headers. */
export interface RateInfo {
  limit: number;
  remaining: number;
  /** epoch ms when the window resets */
  reset: number;
  window: Window;
}

type Window = 'minute' | 'hour' | 'day' | 'week' | 'month';

/** A refusal for a limit (HTTP 429) with the information an application needs to wait. */
export class ApiLimitError extends HttpError {
  constructor(
    code: 'rate_limited' | 'feature_limit' | 'concurrency_limit',
    message: string,
    public retryAfter: number,
    public rate: RateInfo | null,
    details: Record<string, unknown> = {},
  ) {
    super(429, code, message, details);
  }
}

/* --------------------------------------------------------------------- helpers */

/** A counter from a stats document: real Firestore returns nested maps, the test double flat keys. */
export function readNum(data: Record<string, unknown> | undefined | null, path: string): number {
  if (!data) return 0;
  const flat = data[path];
  if (typeof flat === 'number') return flat;
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return 0;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' ? cur : 0;
}

/** The ids of every child under `prefix` in a stats document (nested or flat keys). */
export function childIds(data: Record<string, unknown> | undefined | null, prefix: string): string[] {
  if (!data) return [];
  const out = new Set<string>();
  const nested = data[prefix];
  if (nested && typeof nested === 'object') for (const k of Object.keys(nested)) out.add(k);
  for (const k of Object.keys(data)) if (k.startsWith(`${prefix}.`)) out.add(k.slice(prefix.length + 1).split('.')[0]);
  return [...out];
}

const windowEnd = (w: Window, now: number): number => {
  const d = new Date(now);
  switch (w) {
    case 'minute':
      return Math.floor(now / 60_000) * 60_000 + 60_000;
    case 'hour':
      return Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0 (ISO weeks)
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 7);
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
};

const WINDOW_LIMIT: Record<Window, NumericLimitKey> = {
  minute: 'requestsPerMinute',
  hour: 'requestsPerHour',
  day: 'requestsPerDay',
  week: 'requestsPerWeek',
  month: 'requestsPerMonth',
};

const appLimit = (s: Scope, k: NumericLimitKey) => s.integration.limits[k];
const keyLimit = (s: Scope, k: NumericLimitKey) => s.key.limits?.[k] ?? null;
const hasLimit = (s: Scope, k: NumericLimitKey) => appLimit(s, k) !== null || keyLimit(s, k) !== null;

/** Field names: integration and key ids are plain identifiers (int_<hex>, key_<hex>), safe as field paths. */
const appField = (s: Scope, f: string) => `apps.${s.integration.id}.${f}`;
const keyField = (s: Scope, f: string) => `keys.${s.key.id}.${f}`;

/* ------------------------------------------------------------ per-instance guard */

/**
 * Abuse prevention that applies to every application, Unlimited included: at most
 * HARD_CEILINGS.requestsPerMinute requests per minute per application on one server instance,
 * without any database write.
 */
const burst = new Map<string, { minute: number; n: number }>();
function burstGuard(integrationId: string, now: number) {
  const minute = Math.floor(now / 60_000);
  const cur = burst.get(integrationId);
  if (!cur || cur.minute !== minute) {
    burst.set(integrationId, { minute, n: 1 });
    if (burst.size > 2_000) burst.clear();
    return;
  }
  cur.n++;
  if (cur.n > HARD_CEILINGS.requestsPerMinute) {
    const retry = Math.ceil((windowEnd('minute', now) - now) / 1000);
    throw new ApiLimitError('rate_limited', 'Too many requests. Please slow down.', retry, null, { window: 'minute' });
  }
}

/** Test helper: forget the per-instance burst counters. */
export function resetBurst() {
  burst.clear();
}

/* --------------------------------------------------------------- request counting */

/**
 * Count one request against every request-rate limit of the application and the key. Throws
 * ApiLimitError (429) when a limit is reached; nothing stays counted then.
 */
export async function countRequest(db: Firestore, s: Scope, now = Date.now()): Promise<RateInfo | null> {
  burstGuard(s.integration.id, now);

  type Inc = { path: string; inc: Record<string, number>; data: object; checks: { window: Window; field: string; limit: number }[] };
  const incs: Inc[] = [];
  const expires = (ms: number) => new Date(now + ms).toISOString();
  const addPeriod = (window: 'day' | 'week' | 'month', path: string, periodKey: string, keepMs: number, always: boolean) => {
    const lk = WINDOW_LIMIT[window];
    if (!always && !hasLimit(s, lk)) return;
    const checks: Inc['checks'] = [];
    const a = appLimit(s, lk);
    const k = keyLimit(s, lk);
    if (a !== null) checks.push({ window, field: appField(s, 'requests'), limit: a });
    if (k !== null) checks.push({ window, field: keyField(s, 'requests'), limit: k });
    incs.push({
      path,
      inc: { [appField(s, 'requests')]: 1, [keyField(s, 'requests')]: 1, 'total.requests': 1 },
      data: { period: window, key: periodKey, expiresAt: expires(keepMs) },
      checks,
    });
  };
  // day and month are always counted (analytics); the week only when a weekly limit exists
  addPeriod('day', dayStatsPath(utcDay(now)), utcDay(now), 400 * 86_400_000, true);
  addPeriod('week', weekStatsPath(isoWeek(now)), isoWeek(now), 40 * 86_400_000, false);
  addPeriod('month', monthStatsPath(utcMonth(now)), utcMonth(now), 800 * 86_400_000, true);

  // minute and hour share one short-lived document per application and hour
  if (hasLimit(s, 'requestsPerMinute') || hasLimit(s, 'requestsPerHour')) {
    const hourKey = new Date(now).toISOString().slice(0, 13).replace(/[-T]/g, '');
    const mm = `m${new Date(now).toISOString().slice(14, 16)}`;
    const checks: Inc['checks'] = [];
    const am = appLimit(s, 'requestsPerMinute');
    const ah = appLimit(s, 'requestsPerHour');
    const km = keyLimit(s, 'requestsPerMinute');
    const kh = keyLimit(s, 'requestsPerHour');
    if (am !== null) checks.push({ window: 'minute', field: `i.${mm}`, limit: am });
    if (ah !== null) checks.push({ window: 'hour', field: 'i.h', limit: ah });
    if (km !== null) checks.push({ window: 'minute', field: `k.${s.key.id}.${mm}`, limit: km });
    if (kh !== null) checks.push({ window: 'hour', field: `k.${s.key.id}.h`, limit: kh });
    incs.push({
      path: `${RATE}/${s.integration.id}_${hourKey}`,
      inc: { [`i.${mm}`]: 1, 'i.h': 1, [`k.${s.key.id}.${mm}`]: 1, [`k.${s.key.id}.h`]: 1 },
      data: { integrationId: s.integration.id, expiresAt: expires(2 * 3_600_000) },
      checks,
    });
  }

  const results = await Promise.all(incs.map((i) => db.incrementAndGet(i.path, i.inc, i.data)));

  let binding: RateInfo | null = null;
  let over: { window: Window; limit: number } | null = null;
  incs.forEach((inc, idx) => {
    for (const c of inc.checks) {
      const used = results[idx][c.field] ?? 0;
      const info: RateInfo = { limit: c.limit, remaining: Math.max(0, c.limit - used), reset: windowEnd(c.window, now), window: c.window };
      if (used > c.limit && (!over || windowEnd(c.window, now) > windowEnd(over.window, now))) over = { window: c.window, limit: c.limit };
      if (!binding || info.remaining < binding.remaining) binding = info;
    }
  });

  if (over) {
    const o = over as { window: Window; limit: number };
    // roll the refused request back so it never uses up the allowance
    await Promise.all(
      incs.map((i) => db.incrementAndGet(i.path, Object.fromEntries(Object.keys(i.inc).map((f) => [f, -1])), {}).catch(() => undefined)),
    );
    const reset = windowEnd(o.window, now);
    const retry = Math.max(1, Math.ceil((reset - now) / 1000));
    throw new ApiLimitError('rate_limited', `Request limit reached (${o.limit} per ${o.window}). Try again later.`, retry, { limit: o.limit, remaining: 0, reset, window: o.window }, {
      window: o.window,
      limit: o.limit,
      resetsAt: reset,
    });
  }
  return binding;
}

/* ----------------------------------------------------------------- feature units */

export const UNITS = {
  images: 'imagesPerDay',
  research: 'researchPerDay',
  deep_research: 'deepResearchPerDay',
  documents: 'documentsPerDay',
  tts_chars: 'ttsCharsPerDay',
  stt: 'sttPerDay',
} as const satisfies Record<string, NumericLimitKey>;
export type Unit = keyof typeof UNITS;

const UNIT_LABEL: Record<Unit, string> = {
  images: 'image',
  research: 'web search',
  deep_research: 'Deep Research',
  documents: 'document',
  tts_chars: 'speech character',
  stt: 'transcription',
};

export interface UnitClaim {
  unit: Unit;
  amount: number;
  /** give the units back (the work failed before producing anything); safe to call twice */
  release(): Promise<void>;
}

/**
 * Take `amount` units of a daily feature quota (application and key). Always counted (for
 * analytics), checked only when a limit is set. Throws ApiLimitError when over.
 */
export async function claimUnits(db: Firestore, s: Scope, unit: Unit, amount = 1, now = Date.now()): Promise<UnitClaim> {
  const lk = UNITS[unit];
  const path = dayStatsPath(utcDay(now));
  const a = appField(s, `u.${unit}`);
  const k = keyField(s, `u.${unit}`);
  const got = await db.incrementAndGet(path, { [a]: amount, [k]: amount }, { period: 'day', key: utcDay(now) });
  const appMax = appLimit(s, lk);
  const keyMax = keyLimit(s, lk);
  const over = (appMax !== null && got[a] > appMax) || (keyMax !== null && got[k] > keyMax);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await db.incrementAndGet(path, { [a]: -amount, [k]: -amount }, {}).catch(() => undefined);
  };
  if (over) {
    await release();
    const limit = appMax !== null && got[a] > appMax ? appMax : (keyMax as number);
    const reset = windowEnd('day', now);
    throw new ApiLimitError('feature_limit', `Daily ${UNIT_LABEL[unit]} limit reached (${limit} per day). It resets at 00:00 UTC.`, Math.ceil((reset - now) / 1000), null, {
      feature: unit,
      limit,
      resetsAt: reset,
    });
  }
  return { unit, amount, release };
}

/* ------------------------------------------------------------------ concurrency */

const BUCKET_MS = 120_000;
const localActive = new Map<string, number>();

/**
 * Hold one concurrent-request slot until `release` is called. The hard ceiling is checked per
 * instance without writes; configured limits use a Firestore counter in 2-minute buckets (the
 * current and the previous bucket count), so a slot that was never released (a crashed function)
 * frees itself within 4 minutes.
 */
export async function acquireSlot(db: Firestore, s: Scope, now = Date.now()): Promise<() => Promise<void>> {
  const id = s.integration.id;
  const local = (localActive.get(id) ?? 0) + 1;
  if (local > HARD_CEILINGS.maxConcurrent) {
    throw new ApiLimitError('concurrency_limit', 'Too many requests are running at the same time. Wait for one to finish.', 2, null, { limit: HARD_CEILINGS.maxConcurrent });
  }
  localActive.set(id, local);
  let localReleased = false;
  const releaseLocal = () => {
    if (localReleased) return;
    localReleased = true;
    const n = (localActive.get(id) ?? 1) - 1;
    if (n <= 0) localActive.delete(id);
    else localActive.set(id, n);
  };

  const appMax = appLimit(s, 'maxConcurrent');
  const keyMax = keyLimit(s, 'maxConcurrent');
  if (appMax === null && keyMax === null) return async () => releaseLocal();

  const bucket = Math.floor(now / BUCKET_MS);
  const cur = `${CONC}/${id}_${bucket}`;
  const prev = `${CONC}/${id}_${bucket - 1}`;
  const kf = `k.${s.key.id}`;
  let got: Record<string, number>;
  let before: Record<string, unknown> | undefined;
  try {
    [got, before] = await Promise.all([
      db.incrementAndGet(cur, { i: 1, [kf]: 1 }, { integrationId: id, expiresAt: new Date(now + 3 * BUCKET_MS).toISOString() }),
      db.get<Record<string, unknown>>(prev).then((d) => d?.data),
    ]);
  } catch (err) {
    releaseLocal();
    throw err;
  }
  const app = got.i + Math.max(0, readNum(before, 'i'));
  const key = got[kf] + Math.max(0, readNum(before, kf));
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    releaseLocal();
    await db.incrementAndGet(cur, { i: -1, [kf]: -1 }, {}).catch(() => undefined);
  };
  if ((appMax !== null && app > appMax) || (keyMax !== null && key > keyMax)) {
    await release();
    const limit = appMax !== null && app > appMax ? appMax : (keyMax as number);
    throw new ApiLimitError('concurrency_limit', `Too many requests at the same time (limit ${limit}). Wait for one to finish.`, 2, null, { limit });
  }
  return release;
}

/* ------------------------------------------------------------------ idempotency */

export const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const IDEM_TTL = 24 * 3_600_000;
const IN_PROGRESS_STALE = 10 * 60_000;
const MAX_STORED = 300_000;

export interface IdemStored {
  status: number;
  body: string | null;
}

export type IdemStart =
  | { kind: 'new'; finish(status: number, body: string): Promise<void>; abandon(): Promise<void> }
  | { kind: 'replay'; stored: IdemStored };

export const idemPath = (integrationId: string, key: string) => `${IDEM}/${integrationId}_${shortHash(key, 32)}`;

/**
 * Begin a request with an Idempotency-Key. The same key with the same request replays the stored
 * response; with a different request it is refused (422); while the first is still running a
 * second one is refused (409). Keys are scoped to the application and kept for 24 hours.
 */
export async function beginIdempotent(db: Firestore, integrationId: string, key: string, fingerprint: string, now = Date.now()): Promise<IdemStart> {
  const path = idemPath(integrationId, key);
  const fresh = { integrationId, fingerprint, state: 'running', startedAt: now, expiresAt: new Date(now + IDEM_TTL).toISOString() };
  const start = (): IdemStart => ({
    kind: 'new',
    async finish(status: number, body: string) {
      // server errors are not stored: the application may retry them with the same key
      if (status >= 500) return void (await db.delete(path).catch(() => undefined));
      const keep = body.length <= MAX_STORED ? body : null;
      await db.set(path, { ...fresh, state: 'done', status, body: keep, finishedAt: Date.now() }).catch(() => undefined);
    },
    async abandon() {
      await db.delete(path).catch(() => undefined);
    },
  });
  try {
    await db.commit([{ op: 'set', path, data: fresh, precondition: { exists: false } }]);
    return start();
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
  }
  const doc = await db.get<Record<string, unknown>>(path);
  const d = doc?.data;
  const expired = !d || Date.parse(String(d.expiresAt ?? '')) < now;
  const stale = d?.state === 'running' && typeof d.startedAt === 'number' && now - d.startedAt > IN_PROGRESS_STALE;
  if (expired || stale) {
    await db.set(path, fresh);
    return start();
  }
  if (d.fingerprint !== fingerprint) {
    throw new HttpError(422, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request.');
  }
  if (d.state !== 'done') {
    throw new HttpError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still running. Try again shortly.');
  }
  return { kind: 'replay', stored: { status: typeof d.status === 'number' ? d.status : 200, body: typeof d.body === 'string' ? d.body : null } };
}
