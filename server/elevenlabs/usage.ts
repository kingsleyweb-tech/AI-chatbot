/**
 * ElevenLabs credit control and usage records (server identity only; clients cannot read or write these).
 *
 *  config/voice                  admin settings (enabled, caps, default model), written only by this server
 *  elevenlabsUsage/{day}         app-wide credits, characters, requests and failures for one UTC day
 *  elevenlabsUsage/m-{yyyy-mm}   app-wide credits for one month
 *  elevenlabsRequests/{id}       one entry per request: who, what, model, voice, size, credits, result (never text)
 *  users/{uid}/usage/{day}       the person's own counters (providers.elevenlabs.*, voice.eleven.*)
 *
 * Before every request the expected credits are reserved against the daily, monthly and per-person
 * caps; a request that would pass one is refused, so spending can never run past what an
 * administrator allowed. The exact figure from ElevenLabs' `character-cost` header is recorded after.
 * Fails closed: if the counters cannot be read, nothing runs.
 */
import { adminConfigured, trustedDb } from '../admin.js';
import { normalizeElevenSettings, type ElevenSettings } from '../config/elevenlabs.js';
import { fieldPath, SERVER_TIME, type Firestore } from '../firestore.js';
import { utcDay } from '../cloudflare/budget.js';

export const monthOf = (now = Date.now()) => `m-${new Date(now).toISOString().slice(0, 7)}`;
export const SETTINGS_PATH = 'config/voice';

export type ElevenRequestType = 'tts' | 'preview' | 'design' | 'create_voice';

export interface ElevenUsageEntry {
  uid: string;
  type: ElevenRequestType;
  model: string;
  voiceId?: string | null;
  characters: number;
  ok: boolean;
  /** error code only, never provider text */
  error?: string | null;
  ms?: number;
  /** ElevenLabs request id, for support questions */
  requestId?: string | null;
}

export type CreditRefusal = { ok: false; reason: 'disabled' | 'app_daily' | 'app_monthly' | 'user_daily' | 'unavailable'; message: string };
export interface CreditReservation {
  ok: true;
  settle(credits: number, entry: ElevenUsageEntry): Promise<void>;
}

/* ------------------------------ settings ------------------------------ */

let settingsCache: { at: number; value: ElevenSettings } | null = null;

export async function loadElevenSettings(userDb: Firestore, fresh = false): Promise<ElevenSettings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  let raw: unknown = null;
  try {
    raw = (await (await trustedDb(userDb)).get(SETTINGS_PATH))?.data ?? null;
  } catch {
    // unreadable: defaults (ElevenLabs stays off)
  }
  const value = normalizeElevenSettings(raw);
  settingsCache = { at: Date.now(), value };
  return value;
}

export async function saveElevenSettings(userDb: Firestore, patch: Partial<ElevenSettings>, by: string): Promise<ElevenSettings> {
  const db = await trustedDb(userDb);
  const next = normalizeElevenSettings({ ...(await loadElevenSettings(userDb, true)), ...patch });
  await db.set(SETTINGS_PATH, { ...next, updatedAt: Date.now(), updatedBy: by });
  settingsCache = { at: Date.now(), value: next };
  return next;
}

/* ------------------------------ counters ------------------------------ */

function num(data: Record<string, unknown> | undefined, ...path: string[]): number {
  if (!data) return 0;
  let v: unknown = data;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  if (v === undefined) v = data[path.join('.')];
  return Number(v ?? 0) || 0;
}

export interface ElevenUsageView {
  day: { credits: number; characters: number; requests: number; failed: number };
  month: { credits: number };
  mine: { credits: number };
}

/** Today's and this month's app-wide figures, and the person's own credits today. */
export async function elevenUsage(userDb: Firestore, uid: string, now = Date.now()): Promise<ElevenUsageView> {
  const db = await trustedDb(userDb);
  const day = utcDay(now);
  const [d, m, u] = await Promise.all([
    db.get<Record<string, unknown>>(`elevenlabsUsage/${day}`),
    db.get<Record<string, unknown>>(`elevenlabsUsage/${monthOf(now)}`),
    db.get<Record<string, unknown>>(`users/${uid}/usage/${day}`),
  ]);
  return {
    day: { credits: num(d?.data, 'credits'), characters: num(d?.data, 'characters'), requests: num(d?.data, 'requests'), failed: num(d?.data, 'failed') },
    month: { credits: num(m?.data, 'credits') },
    mine: { credits: num(u?.data, 'providers', 'elevenlabs', 'credits') },
  };
}

/** Credits reserved by requests still running on this server instance. */
const inflight = new Map<number, { uid: string; credits: number }>();
let seq = 0;
const pending = (uid?: string) => [...inflight.values()].filter((r) => !uid || r.uid === uid).reduce((a, r) => a + r.credits, 0);

/** Credits the person may still use today (0 when ElevenLabs is off or a cap is reached). */
export function creditsLeft(s: ElevenSettings, u: ElevenUsageView, uid: string): number {
  if (!s.enabled) return 0;
  return Math.max(
    0,
    Math.min(s.appDailyCredits - u.day.credits - pending(), s.appMonthlyCredits - u.month.credits - pending(), s.userDailyCredits - u.mine.credits - pending(uid)),
  );
}

/**
 * Reserve credits. `personalCap: false` is for administrator actions (Voice Design), which count
 * against the app-wide caps only.
 */
export async function reserveCredits(
  userDb: Firestore,
  uid: string,
  estimate: number,
  opts: { personalCap?: boolean; now?: number } = {},
): Promise<CreditReservation | CreditRefusal> {
  const now = opts.now ?? Date.now();
  const s = await loadElevenSettings(userDb);
  if (!s.enabled) return { ok: false, reason: 'disabled', message: 'The ElevenLabs voice is turned off by the administrator.' };
  if (!adminConfigured()) return { ok: false, reason: 'unavailable', message: 'The ElevenLabs voice is not set up on this server.' };
  let u: ElevenUsageView;
  try {
    u = await elevenUsage(userDb, uid, now);
  } catch {
    return { ok: false, reason: 'unavailable', message: 'The ElevenLabs voice is temporarily unavailable. Please try again shortly.' };
  }
  if (u.day.credits + pending() + estimate > s.appDailyCredits) {
    return { ok: false, reason: 'app_daily', message: 'Today’s ElevenLabs allowance for Atlas AI is used up; the Cloudflare voice is used until 00:00 UTC.' };
  }
  if (u.month.credits + pending() + estimate > s.appMonthlyCredits) {
    return { ok: false, reason: 'app_monthly', message: 'This month’s ElevenLabs allowance for Atlas AI is used up; the Cloudflare voice is used instead.' };
  }
  if (opts.personalCap !== false && u.mine.credits + pending(uid) + estimate > s.userDailyCredits) {
    return { ok: false, reason: 'user_daily', message: 'Your ElevenLabs voice allowance for today is used up; the Cloudflare voice is used until 00:00 UTC.' };
  }
  const id = ++seq;
  inflight.set(id, { uid, credits: estimate });
  return {
    ok: true,
    async settle(credits, entry) {
      inflight.delete(id);
      await recordElevenUsage(userDb, credits, entry, now).catch((err) =>
        console.warn('[elevenlabs] usage write failed', err instanceof Error ? err.message : 'unknown'),
      );
    },
  };
}

/** Add one request's exact credits to the app-wide, monthly and personal counters, plus a history entry. */
export async function recordElevenUsage(userDb: Firestore, credits: number, e: ElevenUsageEntry, now = Date.now()) {
  const db = await trustedDb(userDb);
  const day = utcDay(now);
  const c = Math.max(0, Math.round(credits * 100) / 100);
  const modelKey = e.model.replace(/[^A-Za-z0-9_]/g, '_');
  const failed: Record<string, number> = e.ok ? {} : { failed: 1 };
  await db.commit([
    {
      op: 'increment',
      path: `elevenlabsUsage/${day}`,
      data: { date: day, updatedAt: SERVER_TIME },
      increments: {
        credits: c,
        characters: e.characters,
        requests: 1,
        ...failed,
        [fieldPath('types', e.type, e.ok ? 'ok' : 'failed')]: 1,
        [fieldPath('types', e.type, 'credits')]: c,
        [fieldPath('models', modelKey, 'credits')]: c,
        [fieldPath('models', modelKey, 'requests')]: 1,
        ...(e.error ? { [fieldPath('errors', e.error.replace(/[^A-Za-z0-9_]/g, '_'))]: 1 } : {}),
      },
    },
    {
      op: 'increment',
      path: `elevenlabsUsage/${monthOf(now)}`,
      data: { month: monthOf(now).slice(2), updatedAt: SERVER_TIME },
      increments: { credits: c, characters: e.characters, requests: 1, ...failed },
    },
    {
      op: 'increment',
      path: `users/${e.uid}/usage/${day}`,
      data: { date: day, updatedAt: SERVER_TIME },
      increments: {
        [fieldPath('providers', 'elevenlabs', 'credits')]: c,
        [fieldPath('providers', 'elevenlabs', 'requests')]: 1,
        ...(e.ok ? {} : { [fieldPath('providers', 'elevenlabs', 'failed')]: 1 }),
        [fieldPath('voice', 'eleven', 'requests')]: 1,
        [fieldPath('voice', 'eleven', 'credits')]: c,
        [fieldPath('voice', 'eleven', 'characters')]: e.characters,
      },
    },
    {
      op: 'set',
      path: `elevenlabsRequests/${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      data: {
        at: now,
        day,
        uid: e.uid,
        type: e.type,
        model: e.model,
        voiceId: e.voiceId ?? null,
        characters: e.characters,
        credits: c,
        ok: e.ok,
        error: e.error ?? null,
        ms: e.ms ?? null,
        requestId: e.requestId ?? null,
      },
    },
  ]);
}

/** Most recent requests for the admin view (newest first). */
export async function recentElevenRequests(userDb: Firestore, limit = 30) {
  const db = await trustedDb(userDb);
  return (await db.list<Record<string, unknown>>('elevenlabsRequests', { orderBy: 'at', direction: 'DESCENDING', limit })).map((d) => d.data);
}

export function resetElevenState() {
  inflight.clear();
  settingsCache = null;
  seq = 0;
}
