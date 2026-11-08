/**
 * Keeps Cloudflare Workers AI inside the free daily allowance.
 *
 * - App-wide: Neurons used today (UTC) are counted in `cloudflareUsage/{day}`
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
import { cloudflareDailyLimitActive, nextUtcMidnight } from './client.js';

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const usagePath = (day = utcDay()) => `cloudflareUsage/${day}`;

/** Reservations not yet recorded on this server instance. */
const inflight = new Map<string, number>();
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
  /** record the exact cost (or 0 when the call never reached Cloudflare) and release the reservation */
  settle(actual: number, entry: UsageEntry): Promise<void>;
}

export interface UsageEntry {
  uid: string;
  model: string;
  type: 'image_generate' | 'image_edit' | 'text' | 'safety';
  ok: boolean;
  /** error code only (never text from the request) */
  error?: string | null;
}

const resetTime = (now = Date.now()) => new Date(nextUtcMidnight(now)).toISOString();

export function capMessage(now = Date.now()): string {
  const reset = new Date(nextUtcMidnight(now));
  return `Atlas AI has used today’s free Cloudflare Workers AI allowance, so image creation is paused until ${reset.toISOString().slice(11, 16)} UTC. No paid usage is ever started.`;
}

async function usedToday(db: Firestore, day: string): Promise<number> {
  const doc = await db.get<{ neurons?: number; reserved?: number }>(usagePath(day));
  return Number(doc?.data.neurons ?? 0) || 0;
}

/**
 * Reserve `estimate` Neurons against today's app-wide cap. Fails closed: if
 * today's usage cannot be read, nothing is reserved and nothing runs.
 */
export async function reserveNeurons(userDb: Firestore, estimate: number, now = Date.now()): Promise<Reservation | BudgetRefusal> {
  if (!adminConfigured()) {
    return { ok: false, reason: 'unconfigured', message: 'Image creation is not set up on this server.', resetAt: null };
  }
  if (cloudflareDailyLimitActive(now)) return { ok: false, reason: 'app_cap', message: capMessage(now), resetAt: resetTime(now) };
  const db = await trustedDb(userDb);
  const day = utcDay(now);
  const limits = await loadLimits(userDb);
  let used: number;
  try {
    used = await usedToday(db, day);
  } catch {
    return { ok: false, reason: 'unconfigured', message: 'Image creation is temporarily unavailable. Please try again shortly.', resetAt: null };
  }
  const pending = [...inflight.values()].reduce((a, b) => a + b, 0);
  if (used + pending + estimate > limits.images.appDailyNeurons) {
    return { ok: false, reason: 'app_cap', message: capMessage(now), resetAt: resetTime(now) };
  }
  const id = `r${++seq}`;
  inflight.set(id, estimate);
  return {
    ok: true,
    id,
    async settle(actual: number, entry: UsageEntry) {
      inflight.delete(id);
      await recordUsage(userDb, actual, entry, now).catch((err) =>
        console.warn('[cloudflare] usage write failed', err instanceof Error ? err.message : err),
      );
    },
  };
}

/** Add exact usage to the app-wide and the per-user counters (server identity). */
export async function recordUsage(userDb: Firestore, neurons: number, e: UsageEntry, now = Date.now()) {
  const db = await trustedDb(userDb);
  const day = utcDay(now);
  const n = Math.max(0, +neurons.toFixed(3));
  const kind = e.type;
  const modelKey = e.model.replace(/[^A-Za-z0-9_]/g, '_');
  await db.commit([
    {
      op: 'increment',
      path: usagePath(day),
      data: { date: day, updatedAt: SERVER_TIME },
      increments: {
        neurons: n,
        requests: 1,
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
      },
    },
  ]);
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
export async function claimUserSlot(userDb: Firestore, uid: string, now = Date.now()): Promise<{ ok: true; release: () => void } | BudgetRefusal> {
  if (activeUsers.has(uid)) {
    return { ok: false, reason: 'busy', message: 'An image is already being created for you. Please wait for it to finish.', resetAt: null };
  }
  const last = lastStart.get(uid) ?? 0;
  if (now - last < MIN_GAP_MS) {
    return { ok: false, reason: 'too_soon', message: 'Please wait a few seconds before asking for another image.', resetAt: null };
  }
  const limits = await loadLimits(userDb);
  const today = await imagesToday(userDb, uid, now);
  if (today >= limits.images.perUserDaily) {
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
  inflight.clear();
  activeUsers.clear();
  lastStart.clear();
  seq = 0;
}
