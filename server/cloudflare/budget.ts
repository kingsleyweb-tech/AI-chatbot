/**
 * Keeps Cloudflare Workers AI inside the free daily allowance.
 *
 * - Per account (A and, when configured, B; each has its own free 10,000): Neurons used today
 *   (UTC) are counted in `cloudflareUsage/{day}`
 *   (server-only document). Before every call the expected cost is reserved;
 *   a call that would pass the cap (default 9,000 of the free 10,000) is
 *   refused, so the app never runs into paid usage. Exact cost is recorded
 *   afterwards from Cloudflare's own figure.
 * - Per user: images per day (limits.images.perUserDaily), one image request
 *   at a time, and a short gap between requests.
 */
import { adminConfigured, trustedDb } from '../admin.js';
import { loadLimits } from '../config/limits.js';
import { fieldPath, SERVER_TIME, type Firestore } from '../firestore.js';
import * as H from '../providers/accountHealth.js';
import { ProviderError } from '../providers/types.js';
import {
  cloudflareAccountIds,
  cloudflareAccountUsable,
  cloudflareDailyLimitActive,
  currentCloudflareAccount,
  nextUtcMidnight,
  noteCloudflareSuccess,
  withCloudflareAccount,
  type CfAccountId,
} from './client.js';

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const usagePath = (day = utcDay()) => `cloudflareUsage/${day}`;

let seq = 0;

export type BudgetRefusal = {
  ok: false;
  reason: 'app_cap' | 'user_daily' | 'busy' | 'too_soon' | 'unconfigured';
  message: string;
  resetAt: string | null;
};

export interface Reservation {
  ok: true;
  id: string;
  /** the Cloudflare account the Neurons are reserved on (it can change inside `run`) */
  readonly account: CfAccountId;
  /**
   * Run the Cloudflare call(s) on the reserved account. If the account turns out to be unusable
   * before any Neurons were spent (daily allowance used up, credentials rejected, rate limit,
   * outage), the reservation moves to the other account and `fn` runs once more there.
   * `spent` reports Neurons already used inside `fn` (no move once anything was spent).
   */
  run<T>(fn: () => Promise<T>, spent?: () => number): Promise<T>;
  /** record the exact cost (or 0 when the call never reached Cloudflare) and release the reservation */
  settle(actual: number, entry: UsageEntry): Promise<void>;
}

export interface UsageEntry {
  uid: string;
  model: string;
  type: 'image_generate' | 'image_edit' | 'text' | 'safety' | 'stt' | 'tts' | 'translate' | 'turn';
  ok: boolean;
  /** error code only (never text from the request) */
  error?: string | null;
  /** account the call ran on (default: the account of the surrounding reservation) */
  account?: CfAccountId;
}

const resetTime = (now = Date.now()) => new Date(nextUtcMidnight(now)).toISOString();

export function capMessage(now = Date.now()): string {
  const reset = new Date(nextUtcMidnight(now));
  return `Atlas AI has used today’s free Cloudflare Workers AI allowance, so image creation is paused until ${reset.toISOString().slice(11, 16)} UTC. No paid usage is ever started.`;
}

/*
 * Per-account counters in `cloudflareUsage/{day}` (each account has its own free allowance and
 * its own copy of the cap):
 *   accounts.{A|B}.neurons   exact Neurons used (Cloudflare's own figure)
 *   accounts.{A|B}.claimed   Neurons reserved by calls still running, on any server instance
 * `neurons` stays the app-wide total. Usage recorded before accounts were tracked counts toward A.
 */
const claimField = (account: CfAccountId) => fieldPath('accounts', account, 'claimed');

/** Neurons used today on one account (exact usage only, not reservations). */
export function accountNeurons(data: Record<string, unknown> | undefined, account: CfAccountId): number {
  if (account === 'B') return counter(data, 'accounts', 'B', 'neurons');
  return Math.max(0, counter(data, 'neurons') - counter(data, 'accounts', 'B', 'neurons'));
}

/**
 * Claim `estimate` Neurons on the first account (least used first) that stays inside the cap.
 * The claim is an atomic increment, so two server instances can never both take the last
 * Neurons of an account: a claim that lands past the cap is undone and the next account is tried.
 * Fails closed (null + 'error') when today's usage cannot be read or written.
 */
async function claim(db: Firestore, estimate: number, cap: number, day: string, exclude: CfAccountId[], now: number): Promise<CfAccountId | 'full' | 'error'> {
  await H.syncShared('cloudflare', now);
  const ids = cloudflareAccountIds().filter((id) => !exclude.includes(id) && cloudflareAccountUsable(id, now));
  if (!ids.length) return 'full';
  let data: Record<string, unknown> | undefined;
  try {
    data = (await db.get<Record<string, unknown>>(usagePath(day)))?.data;
  } catch {
    return 'error';
  }
  const load = (id: CfAccountId) => accountNeurons(data, id) + counter(data, 'accounts', id, 'claimed');
  for (const id of [...ids].sort((a, b) => load(a) - load(b))) {
    const used = accountNeurons(data, id);
    if (used + counter(data, 'accounts', id, 'claimed') + estimate > cap) continue;
    let claimed: number;
    try {
      claimed = (await db.incrementAndGet(usagePath(day), { [claimField(id)]: estimate }, { date: day }))[claimField(id)];
    } catch {
      return 'error';
    }
    if (used + claimed <= cap) return id;
    await db.incrementAndGet(usagePath(day), { [claimField(id)]: -estimate }).catch(() => undefined);
  }
  return 'full';
}

/** Errors after which the same call may run on the other account (when no Neurons were spent). */
const MOVE_ON = new Set(['daily_limit', 'invalid_key', 'rate_limited', 'not_configured', 'model_unavailable', 'provider_error']);

/**
 * Reserve `estimate` Neurons against today's cap on one of the Cloudflare accounts. Fails closed:
 * if today's usage cannot be read, nothing is reserved and nothing runs.
 */
export async function reserveNeurons(userDb: Firestore, estimate: number, now = Date.now()): Promise<Reservation | BudgetRefusal> {
  if (!adminConfigured()) {
    return { ok: false, reason: 'unconfigured', message: 'Image creation is not set up on this server.', resetAt: null };
  }
  if (cloudflareDailyLimitActive(now)) return { ok: false, reason: 'app_cap', message: capMessage(now), resetAt: resetTime(now) };
  const db = await trustedDb(userDb);
  const day = utcDay(now);
  const limits = await loadLimits(userDb);
  const cap = limits.images.appDailyNeurons;
  const got = await claim(db, estimate, cap, day, [], now);
  if (got === 'error') return { ok: false, reason: 'unconfigured', message: 'Image creation is temporarily unavailable. Please try again shortly.', resetAt: null };
  if (got === 'full') {
    // every account used up (or resting after a rejected key / rate limit)
    const allSpent = cloudflareAccountIds().every((id) => cloudflareDailyLimitActive(now, id) || cloudflareAccountUsable(id, now));
    return allSpent
      ? { ok: false, reason: 'app_cap', message: capMessage(now), resetAt: resetTime(now) }
      : { ok: false, reason: 'unconfigured', message: 'Image creation is temporarily unavailable. Please try again shortly.', resetAt: null };
  }
  const id = `r${++seq}`;
  let account: CfAccountId = got;
  const tried: CfAccountId[] = [got];
  let settled = false;
  const release = (from: CfAccountId) => db.incrementAndGet(usagePath(day), { [claimField(from)]: -estimate }).catch(() => undefined);
  return {
    ok: true,
    id,
    get account() {
      return account;
    },
    async run<T>(fn: () => Promise<T>, spent?: () => number): Promise<T> {
      for (;;) {
        try {
          return await withCloudflareAccount(account, fn);
        } catch (err) {
          const neurons = (err as { neurons?: number }).neurons ?? 0;
          if (!(err instanceof ProviderError) || !MOVE_ON.has(err.code) || neurons > 0 || (spent?.() ?? 0) > 0) throw err;
          const next = await claim(db, estimate, cap, day, tried, Date.now());
          if (next === 'full' || next === 'error') throw err;
          const from = account;
          await release(from);
          account = next;
          tried.push(next);
          void H.logEvent({ provider: 'cloudflare', account: from, to: next, kind: 'switch', reason: err.code });
        }
      }
    },
    async settle(actual: number, entry: UsageEntry) {
      if (settled) return;
      settled = true;
      if (entry.ok) noteCloudflareSuccess(account);
      await recordUsage(userDb, actual, { ...entry, account: entry.account ?? account }, now, estimate).catch((err) =>
        console.warn('[cloudflare] usage write failed', err instanceof Error ? err.message : err),
      );
    },
  };
}

/**
 * Add exact usage to the app-wide, per-account and per-user counters (server identity).
 * `release` returns that many reserved Neurons to the account in the same write.
 */
export async function recordUsage(userDb: Firestore, neurons: number, e: UsageEntry, now = Date.now(), release = 0) {
  const db = await trustedDb(userDb);
  const day = utcDay(now);
  const n = Math.max(0, +neurons.toFixed(3));
  const kind = e.type;
  const modelKey = e.model.replace(/[^A-Za-z0-9_]/g, '_');
  const account = e.account ?? currentCloudflareAccount();
  await db.commit([
    {
      op: 'increment',
      path: usagePath(day),
      data: { date: day, updatedAt: SERVER_TIME },
      increments: {
        neurons: n,
        requests: 1,
        [fieldPath('accounts', account, 'neurons')]: n,
        [fieldPath('accounts', account, 'requests')]: 1,
        ...(e.ok ? {} : { [fieldPath('accounts', account, 'failed')]: 1 }),
        ...(release ? { [claimField(account)]: -release } : {}),
        [fieldPath('types', kind, e.ok ? 'ok' : 'failed')]: 1,
        [fieldPath('models', modelKey, 'neurons')]: n,
        [fieldPath('models', modelKey, 'requests')]: 1,
        ...(e.error ? { [fieldPath('errors', e.error.replace(/[^A-Za-z0-9_]/g, '_'))]: 1 } : {}),
      },
    },
    {
      op: 'increment',
      path: `users/${e.uid}/usage/${day}`,
      data: { date: day, updatedAt: SERVER_TIME },
      increments: {
        [fieldPath('providers', 'cloudflare', 'neurons')]: n,
        [fieldPath('providers', 'cloudflare', 'requests')]: 1,
        ...(e.ok ? {} : { [fieldPath('providers', 'cloudflare', 'failed')]: 1 }),
        ...(kind === 'image_generate' || kind === 'image_edit'
          ? { [fieldPath('images', e.ok ? (kind === 'image_edit' ? 'edited' : 'generated') : 'failed')]: 1 }
          : {}),
        ...(kind === 'stt' || kind === 'tts' || kind === 'translate' || kind === 'turn'
          ? { [fieldPath('voice', kind, 'requests')]: 1, [fieldPath('voice', kind, 'neurons')]: n, ...(e.ok ? {} : { [fieldPath('voice', kind, 'failed')]: 1 }) }
          : {}),
      },
    },
  ]);
}

/** A nested counter (a.b.c); also accepts the flat "a.b.c" key some stores return. */
function counter(data: Record<string, unknown> | undefined, ...path: string[]): number {
  if (!data) return 0;
  let v: unknown = data;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  if (v === undefined) v = data[path.join('.')];
  return Number(v ?? 0) || 0;
}

/** Neurons one model used today, app-wide (for features with their own smaller share). */
export async function modelNeuronsToday(userDb: Firestore, model: string, now = Date.now()): Promise<number> {
  const db = await trustedDb(userDb);
  const doc = await db.get<Record<string, unknown>>(usagePath(utcDay(now)));
  return counter(doc?.data, 'models', model.replace(/[^A-Za-z0-9_]/g, '_'), 'neurons');
}

/** Neurons one person used today for a voice feature (stt, tts, translate). */
export async function userVoiceNeuronsToday(userDb: Firestore, uid: string, kind: 'stt' | 'tts' | 'translate', now = Date.now()): Promise<number> {
  const db = await trustedDb(userDb);
  const doc = await db.get<Record<string, unknown>>(`users/${uid}/usage/${utcDay(now)}`);
  return counter(doc?.data, 'voice', kind, 'neurons');
}

/** End-of-turn checks one person made today. */
export async function userTurnChecksToday(userDb: Firestore, uid: string, now = Date.now()): Promise<number> {
  const db = await trustedDb(userDb);
  const doc = await db.get<Record<string, unknown>>(`users/${uid}/usage/${utcDay(now)}`);
  return counter(doc?.data, 'voice', 'turn', 'requests');
}

/* ------------------------------ per-user limits ------------------------------ */

const activeUsers = new Map<string, number>();
const lastStart = new Map<string, number>();
export const MIN_GAP_MS = 8_000;

/** Images this user created today (successful generations and edits). */
export async function imagesToday(userDb: Firestore, uid: string, now = Date.now()): Promise<number> {
  const doc = await userDb.get<{ images?: { generated?: number; edited?: number } }>(`users/${uid}/usage/${utcDay(now)}`).catch(() => null);
  return (Number(doc?.data.images?.generated ?? 0) || 0) + (Number(doc?.data.images?.edited ?? 0) || 0);
}

/** Claim this user's single image slot, or say why not. Call the returned release when done. */
export async function claimUserSlot(
  userDb: Firestore,
  uid: string,
  now = Date.now(),
  /** the AI usage allowance (server/usage) already counted this image, so the older per-day cap is not applied twice */
  opts: { allowanceChecked?: boolean } = {},
): Promise<{ ok: true; release: () => void } | BudgetRefusal> {
  if (activeUsers.has(uid)) {
    return { ok: false, reason: 'busy', message: 'An image is already being created for you. Please wait for it to finish.', resetAt: null };
  }
  const last = lastStart.get(uid) ?? 0;
  if (now - last < MIN_GAP_MS) {
    return { ok: false, reason: 'too_soon', message: 'Please wait a few seconds before asking for another image.', resetAt: null };
  }
  const limits = opts.allowanceChecked ? null : await loadLimits(userDb);
  const today = limits ? await imagesToday(userDb, uid, now) : 0;
  if (limits && today >= limits.images.perUserDaily) {
    return {
      ok: false,
      reason: 'user_daily',
      message: `You have created ${today} image${today === 1 ? '' : 's'} today, the daily limit. You can create more after 00:00 UTC.`,
      resetAt: resetTime(now),
    };
  }
  activeUsers.set(uid, now);
  lastStart.set(uid, now);
  return { ok: true, release: () => activeUsers.delete(uid) };
}

export function resetBudgetState() {
  activeUsers.clear();
  lastStart.clear();
  seq = 0;
}
