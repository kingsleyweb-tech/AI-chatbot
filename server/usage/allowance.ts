/**
 * Individual AI allowances, enforced on the server (see policy.ts for the rules).
 *
 * Flow for every AI request: check -> reserve (atomic) -> accept -> run -> settle.
 * - The reservation and the counter change are one Firestore commit, guarded by the counter
 *   document's update time (optimistic concurrency, retried on a conflict), so two requests
 *   at once can never both take the last unit.
 * - Each reservation has the request's id (usageAccounts/{uid}/reservations/{id}): a retry
 *   of the same request finds it and is not counted again.
 * - A request that fails before it produced anything is released (its units are given back).
 * - Once accepted, a request is never stopped by its allowance.
 *
 * Counters live on usageAccounts/{uid} (read-only for the owner and administrators in the
 * Firestore rules; only the server writes). Daily totals across all users go to
 * usageStats/{day} for the administrator analytics.
 */
import { randomBytes } from 'node:crypto';
import { adminConfigured, adminDb } from '../admin.js';
import type { Firestore, Write } from '../firestore.js';
import { SERVER_TIME } from '../firestore.js';
import { HttpError } from '../http.js';
import {
  costOf,
  dailyPeriod,
  decide,
  effectiveLimits,
  featureView,
  FEATURES,
  availableFeatures,
  type AvailableFeature,
  normalizeUsageConfig,
  refusalMessage,
  weeklyPeriod,
  type CostDetail,
  type Counter,
  type Effective,
  type FeatureId,
  type FeatureView,
  type UsageAccount,
  type UsageConfig,
  usedNow,
} from './policy.js';

export const USAGE_CONFIG_PATH = 'config/usage';
export const accountPath = (uid: string) => `usageAccounts/${uid}`;
const reservationPath = (uid: string, id: string) => `usageAccounts/${uid}/reservations/${id}`;

let cache: { value: UsageConfig; at: number } | null = null;
const TTL = 60_000;

export async function loadUsageConfig(db: Firestore, fresh = false): Promise<UsageConfig> {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  const doc = await db.get<Record<string, unknown>>(USAGE_CONFIG_PATH).catch(() => null);
  const value = normalizeUsageConfig(doc?.data);
  cache = { value, at: Date.now() };
  return value;
}
export function clearUsageCache() {
  cache = null;
}

export interface UsageSnapshot {
  profile: { id: string; name: string };
  unlimited: Effective['unlimited'];
  unlimitedUntil: number | null;
  timezone: string;
  enabled: boolean;
  features: FeatureView[];
  generatedAt: number;
}

export function snapshotOf(cfg: UsageConfig, acct: UsageAccount | null, admin: boolean, now = Date.now()): UsageSnapshot {
  const eff = effectiveLimits(cfg, acct, admin, now);
  return {
    profile: { id: eff.profileId, name: eff.profileName },
    unlimited: eff.unlimited,
    unlimitedUntil: eff.unlimitedUntil,
    timezone: cfg.reset.timezone,
    enabled: cfg.enabled,
    features: FEATURES.map((f) => featureView(f, cfg, eff, acct?.counters?.[f], now)),
    generatedAt: now,
  };
}

export async function usageSnapshot(db: Firestore, uid: string, admin: boolean, now = Date.now()): Promise<UsageSnapshot & { history: UsageDayRow[] }> {
  const [cfg, acct, days] = await Promise.all([
    loadUsageConfig(db),
    db.get<UsageAccount>(accountPath(uid)).catch(() => null),
    usageHistory(db, uid),
  ]);
  return { ...snapshotOf(cfg, acct?.data ?? null, admin, now), history: days };
}

export type UsageDayRow = { day: string } & Partial<Record<FeatureId, number>>;

/** The last days of a user's usage, newest first (units per feature). */
export async function usageHistory(db: Firestore, uid: string, limit = 14): Promise<UsageDayRow[]> {
  const rows = await db.list<UsageDayRow>(`${accountPath(uid)}/days`, { orderBy: 'day', direction: 'DESCENDING', limit }).catch(() => []);
  return rows.map((r) => {
    const out: UsageDayRow = { day: r.data.day ?? r.id };
    for (const f of FEATURES) if (typeof r.data[f] === 'number' && r.data[f]! > 0) out[f] = r.data[f];
    return out;
  });
}

interface ReservationDoc {
  feature: FeatureId;
  cost: number;
  state: 'reserved' | 'settled' | 'released';
  d: string;
  w: string;
  actual?: number;
}

export interface Reservation {
  feature: FeatureId;
  cost: number;
  /** false when this request was already counted (a retry) or nothing is counted */
  counted: boolean;
  /** the feature after this reservation, for the usage indicator */
  view: FeatureView;
  /** keep the units (optionally a different final amount); safe to call more than once */
  settle(actual?: number): Promise<void>;
  /** give the units back: the request failed before it produced anything */
  release(): Promise<void>;
}

export class UsageLimitError extends HttpError {
  /** the feature that reached its limit (only that feature is refused; the others carry on) */
  readonly feature: FeatureId;
  constructor(feature: FeatureId, period: 'daily' | 'weekly', used: number, limit: number, resetsAt: number, tz: string, available?: AvailableFeature[]) {
    super(429, 'usage_limit', refusalMessage(feature, period, resetsAt, tz, available), { feature, period, used, limit, resetsAt, ...(available ? { available } : {}) });
    this.feature = feature;
  }
}

const MAX_TRIES = 6;
const isConflict = (err: unknown) => (err as { status?: number }).status === 409;

/** A reservation that counts nothing (allowances unavailable: no server identity). */
function noop(feature: FeatureId, cost: number, view: FeatureView): Reservation {
  return { feature, cost, counted: false, view, settle: async () => undefined, release: async () => undefined };
}

export interface ReserveInput {
  uid: string;
  admin: boolean;
  feature: FeatureId;
  /** the request's own id (a retry sends the same id); a random one when there is none */
  requestId?: string | null;
  detail?: CostDetail;
  now?: number;
}

/**
 * Reserve units for one request, or throw UsageLimitError (HTTP 429) before anything starts.
 * `db` must be the server identity (users cannot write their own counters).
 */
export async function reserveUsage(db: Firestore, input: ReserveInput): Promise<Reservation> {
  const { uid, admin, feature } = input;
  const cost = costOf(feature, input.detail);
  const requestId = (input.requestId && /^[A-Za-z0-9_-]{1,120}$/.test(input.requestId) ? input.requestId : null) ?? randomBytes(9).toString('hex');
  const rid = `${feature}-${requestId}`;
  const cfg = await loadUsageConfig(db);
  const now = input.now ?? Date.now();

  for (let attempt = 0; ; attempt++) {
    const [acctDoc, resDoc] = await Promise.all([db.get<UsageAccount>(accountPath(uid)), db.get<ReservationDoc>(reservationPath(uid, rid))]);
    const acct = acctDoc?.data ?? null;
    const eff = effectiveLimits(cfg, acct, admin, now);

    // a retry of a request that was already counted: accept without counting it again
    if (resDoc && resDoc.data.state !== 'released') {
      return handle(db, uid, rid, resDoc.data.feature, resDoc.data.cost, false, featureView(feature, cfg, eff, acct?.counters?.[feature], now));
    }

    const verdict = decide(feature, cost, cfg, eff, acct?.counters?.[feature], now);
    if (!verdict.ok) {
      const views = FEATURES.map((x) => featureView(x, cfg, eff, acct?.counters?.[x], now));
      throw new UsageLimitError(feature, verdict.period, verdict.used, verdict.limit, verdict.resetsAt, cfg.reset.timezone, availableFeatures(views, feature));
    }

    const counters = { ...(acct?.counters ?? {}), [feature]: verdict.counter };
    const writes: Write[] = [
      {
        op: 'set',
        path: accountPath(uid),
        merge: true,
        // a temporary unlimited grant that ended is cleared in the same commit (the profile was never changed)
        data: { counters, ...(eff.grantExpired ? { unlimited: null } : {}), updatedAt: SERVER_TIME },
        precondition: acctDoc?.updateTime ? { updateTime: acctDoc.updateTime } : { exists: false },
      },
      ...(eff.grantExpired && acct?.unlimited ? [grantExpiredLog(uid, acct, now)] : []),
      {
        op: 'set',
        path: reservationPath(uid, rid),
        data: { feature, cost, state: 'reserved', d: verdict.counter.d, w: verdict.counter.w, createdAt: SERVER_TIME } satisfies ReservationDoc & { createdAt: unknown },
        precondition: resDoc?.updateTime ? { updateTime: resDoc.updateTime } : { exists: false },
      },
      {
        op: 'increment',
        path: `usageStats/${verdict.counter.d}`,
        data: { day: verdict.counter.d, updatedAt: SERVER_TIME },
        increments: { [`${feature}_requests`]: 1, [`${feature}_units`]: cost },
      },
      // the user's own history (Usage page)
      { op: 'increment', path: `${accountPath(uid)}/days/${verdict.counter.d}`, data: { day: verdict.counter.d }, increments: { [feature]: cost } },
    ];
    try {
      await db.commit(writes);
    } catch (err) {
      if (isConflict(err) && attempt < MAX_TRIES) continue;
      throw err;
    }
    const after: UsageAccount = { ...(acct ?? {}), counters };
    return handle(db, uid, rid, feature, cost, true, featureView(feature, cfg, eff, after.counters?.[feature], now));
  }
}

function handle(db: Firestore, uid: string, rid: string, feature: FeatureId, cost: number, counted: boolean, view: FeatureView): Reservation {
  let done = false;
  const finish = async (actual: number, state: 'settled' | 'released') => {
    if (done) return;
    done = true;
    try {
      await finishReservation(db, uid, rid, actual, state);
    } catch (err) {
      console.warn('[usage] could not settle a reservation', err instanceof Error ? err.message : err);
    }
  };
  return {
    feature,
    cost,
    counted,
    view,
    settle: (actual = cost) => finish(Math.max(0, actual), 'settled'),
    release: () => finish(0, 'released'),
  };
}

/** Settle or release: move the counters by (actual - reserved) if the reservation is still open. */
async function finishReservation(db: Firestore, uid: string, rid: string, actual: number, state: 'settled' | 'released') {
  for (let attempt = 0; ; attempt++) {
    const [acctDoc, resDoc] = await Promise.all([db.get<UsageAccount>(accountPath(uid)), db.get<ReservationDoc>(reservationPath(uid, rid))]);
    if (!resDoc || resDoc.data.state !== 'reserved') return; // already finished (or never made)
    const r = resDoc.data;
    const delta = actual - r.cost;
    const writes: Write[] = [
      { op: 'set', path: reservationPath(uid, rid), merge: true, data: { state, actual, settledAt: SERVER_TIME }, precondition: { updateTime: resDoc.updateTime! } },
    ];
    const c = acctDoc?.data.counters?.[r.feature];
    if (delta !== 0 && c && acctDoc?.updateTime) {
      // only the periods the reservation was counted in (a reset since then already cleared it)
      const next: Counter = {
        d: c.d,
        du: c.d === r.d ? Math.max(0, c.du + delta) : c.du,
        w: c.w,
        wu: c.w === r.w ? Math.max(0, c.wu + delta) : c.wu,
      };
      writes.push({
        op: 'set',
        path: accountPath(uid),
        merge: true,
        data: { counters: { ...acctDoc.data.counters, [r.feature]: next }, updatedAt: SERVER_TIME },
        precondition: { updateTime: acctDoc.updateTime },
      });
      writes.push({ op: 'increment', path: `${accountPath(uid)}/days/${r.d}`, data: { day: r.d }, increments: { [r.feature]: delta } });
      writes.push({ op: 'increment', path: `usageStats/${r.d}`, data: { updatedAt: SERVER_TIME }, increments: { [`${r.feature}_units`]: delta, ...(state === 'released' ? { [`${r.feature}_released`]: 1 } : {}) } });
    }
    try {
      await db.commit(writes);
      return;
    } catch (err) {
      if (isConflict(err) && attempt < MAX_TRIES) continue;
      throw err;
    }
  }
}

/** Audit entry for a temporary unlimited grant that ended (written with the reservation that noticed). */
function grantExpiredLog(uid: string, acct: UsageAccount, now: number): Write {
  return {
    op: 'set',
    path: `adminLogs/${String(now).padStart(14, '0')}_${randomBytes(4).toString('hex')}`,
    data: {
      action: 'usage_unlimited_expired',
      adminUid: 'system',
      adminEmail: null,
      targetUid: uid,
      targetEmail: null,
      detail: `Temporary unlimited access ended; profile ${acct.profile ?? 'default'} applies again`,
      changes: { before: { unlimitedUntil: acct.unlimited?.until ?? null }, after: { unlimited: false, profile: acct.profile ?? null } },
      at: new Date(now),
    },
  };
}

/** The server identity for allowance writes, or null when it is not configured (allowances off). */
export async function usageDb(): Promise<Firestore | null> {
  if (!adminConfigured()) return null;
  try {
    return await adminDb();
  } catch {
    return null;
  }
}

/**
 * Reserve with the server identity. Without one (local setups without a service account) the
 * allowance cannot be stored, so nothing is counted and the request goes ahead: the provider
 * safeguards still apply.
 */
export async function reserveFor(input: ReserveInput): Promise<Reservation> {
  const db = await usageDb();
  if (!db) {
    console.warn('[usage] FIREBASE_SERVICE_ACCOUNT is not set: individual allowances are not enforced');
    const cfg = normalizeUsageConfig(null);
    return noop(input.feature, costOf(input.feature, input.detail), featureView(input.feature, cfg, effectiveLimits(cfg, null, true, Date.now()), undefined, Date.now()));
  }
  return reserveUsage(db, input);
}

/* ---------------------------------------------------------------- administrator operations */

/** Clear a user's counters for one feature or all, for the current day and/or week. */
export async function resetAllowance(db: Firestore, uid: string, feature: FeatureId | 'all', period: 'daily' | 'weekly' | 'both', now = Date.now()) {
  const cfg = await loadUsageConfig(db, true);
  const day = dailyPeriod(now, cfg.reset);
  const week = weeklyPeriod(now, cfg.reset);
  for (let attempt = 0; ; attempt++) {
    const doc = await db.get<UsageAccount>(accountPath(uid));
    const counters = { ...(doc?.data.counters ?? {}) };
    const before = structuredClone(counters);
    for (const f of feature === 'all' ? FEATURES : [feature]) {
      const cur = usedNow(counters[f], day, week);
      counters[f] = { d: day.key, du: period === 'weekly' ? cur.du : 0, w: week.key, wu: period === 'daily' ? cur.wu : 0 };
    }
    try {
      await db.commit([
        {
          op: 'set',
          path: accountPath(uid),
          merge: true,
          data: { counters, updatedAt: SERVER_TIME },
          precondition: doc?.updateTime ? { updateTime: doc.updateTime } : { exists: false },
        },
      ]);
      return { before, after: counters };
    } catch (err) {
      if (isConflict(err) && attempt < MAX_TRIES) continue;
      throw err;
    }
  }
}

/** Change the administrator-managed fields (profile, custom limits, override, unlimited grant). */
export async function updateAccount(db: Firestore, uid: string, change: (a: UsageAccount) => Partial<UsageAccount>) {
  for (let attempt = 0; ; attempt++) {
    const doc = await db.get<UsageAccount>(accountPath(uid));
    const before = doc?.data ?? {};
    const patch = change(before);
    try {
      await db.commit([
        {
          op: 'set',
          path: accountPath(uid),
          merge: true,
          data: { ...patch, updatedAt: SERVER_TIME },
          precondition: doc?.updateTime ? { updateTime: doc.updateTime } : { exists: false },
        },
      ]);
      return { before, after: { ...before, ...patch } as UsageAccount };
    } catch (err) {
      if (isConflict(err) && attempt < MAX_TRIES) continue;
      throw err;
    }
  }
}
