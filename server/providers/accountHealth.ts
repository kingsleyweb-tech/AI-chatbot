/**
 * Health of each provider account (Gemini project, Cloudflare account), per model where it matters.
 *
 * - In memory, per server instance: active requests, request starts in the last minute, and
 *   cooldowns with exponential backoff (a temporary 429 never disables an account for good).
 * - Shared between instances: every cooldown is also written to `providerHealth/{provider}`
 *   (server-only; the Firestore rules give clients no access) and read back at most every
 *   15 seconds, so an instance learns that another one hit a limit without sending a request
 *   of its own. An expired cooldown simply ends: the next real request is the availability
 *   test, so an exhausted account is never probed with extra calls.
 * - Recent events (cooldowns, account switches, rejected keys) go to `providerEvents` for the
 *   administrator dashboard. Nothing here ever holds a key, a token or an account id.
 */
import { adminConfigured, adminDb } from '../admin.js';
import { SERVER_TIME } from '../firestore.js';

export type ProviderName = 'gemini' | 'cloudflare';
export type CooldownReason = 'rpm' | 'rpd' | 'daily_allowance' | 'auth' | 'unavailable' | 'outage' | 'guard';

export interface Cooldown {
  until: number;
  reason: CooldownReason;
}

interface Local {
  active: number;
  starts: number[];
  streak: number;
  lastOkAt: number;
  lastFailAt: number;
  lastError: string | null;
}

const local = new Map<string, Local>();
const cool = new Map<string, Cooldown>();
const shared = new Map<ProviderName, { at: number; entries: Record<string, Cooldown>; raw: Record<string, unknown> }>();
const SHARED_TTL_MS = 15_000;
/** The whole account (for example a rejected key), not one model. */
export const ANY_MODEL = '*';

const scopeKey = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const key = (p: ProviderName, account: string, scope: string) => `${p}|${account}|${scope}`;
const docKey = (account: string, scope: string) => `${account}__${scopeKey(scope)}`;

function stateOf(p: ProviderName, account: string, scope: string): Local {
  const k = key(p, account, scope);
  let s = local.get(k);
  if (!s) {
    s = { active: 0, starts: [], streak: 0, lastOkAt: 0, lastFailAt: 0, lastError: null };
    local.set(k, s);
  }
  return s;
}

/** Exponential backoff: base, 2x base, 4x base ... up to max; a provider's retry hint wins when longer. */
export function backoffMs(streak: number, baseMs: number, maxMs: number, retryAfterMs?: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, streak - 1));
  return Math.max(exp, Math.min(maxMs, retryAfterMs ?? 0));
}

/** The cooldown that applies now (local or shared), or null. */
export function cooldownOf(p: ProviderName, account: string, scope: string, now = Date.now()): Cooldown | null {
  const pick = (c: Cooldown | undefined) => (c && c.until > now ? c : null);
  const fromShared = shared.get(p)?.entries;
  const candidates = [
    pick(cool.get(key(p, account, scope))),
    pick(cool.get(key(p, account, ANY_MODEL))),
    pick(fromShared?.[docKey(account, scope)]),
    pick(fromShared?.[docKey(account, ANY_MODEL)]),
  ].filter((c): c is Cooldown => c !== null);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.until >= b.until ? a : b));
}

/** Put an account (and model, or ANY_MODEL) into cooldown, here and for every instance. */
export function startCooldown(
  p: ProviderName,
  account: string,
  scope: string,
  ms: number,
  reason: CooldownReason,
  detail: { model?: string; error?: string } = {},
  now = Date.now(),
): Cooldown {
  const s = stateOf(p, account, scope);
  s.lastFailAt = now;
  s.lastError = detail.error ?? reason;
  const already = cooldownOf(p, account, scope, now);
  const c: Cooldown = { until: Math.max(now + ms, already?.until ?? 0), reason };
  cool.set(key(p, account, scope), c);
  if (!already) {
    void persist(p, { [docKey(account, scope)]: c });
    void logEvent({ provider: p, account, kind: 'cooldown', reason, model: detail.model ?? (scope === ANY_MODEL ? null : scope), until: c.until, error: detail.error ?? null });
  }
  return c;
}

/** Consecutive failures on this account/model (drives the backoff). */
export function failureStreak(p: ProviderName, account: string, scope: string): number {
  return stateOf(p, account, scope).streak;
}

export function noteFailure(p: ProviderName, account: string, scope: string, error: string, now = Date.now()) {
  const s = stateOf(p, account, scope);
  s.streak++;
  s.lastFailAt = now;
  s.lastError = error;
}

export function noteSuccess(p: ProviderName, account: string, scope: string, now = Date.now()) {
  const s = stateOf(p, account, scope);
  s.streak = 0;
  s.lastOkAt = now;
  s.lastError = null;
}

/** Count a request as started; call the returned function when it ends (success or not). */
export function begin(p: ProviderName, account: string, scope: string, now = Date.now()): () => void {
  const s = stateOf(p, account, scope);
  s.active++;
  s.starts.push(now);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    s.active = Math.max(0, s.active - 1);
  };
}

/** Take back a start that never reached the provider. */
export function unstart(p: ProviderName, account: string, scope: string, at: number) {
  const s = stateOf(p, account, scope);
  const i = s.starts.lastIndexOf(at);
  if (i >= 0) s.starts.splice(i, 1);
}

/** Requests started on this instance in the last minute, and those still running. */
export function load(p: ProviderName, account: string, scope: string, now = Date.now()): { lastMinute: number; active: number } {
  const s = stateOf(p, account, scope);
  s.starts = s.starts.filter((t) => now - t < 60_000);
  return { lastMinute: s.starts.length, active: s.active };
}

export function localSnapshot(p: ProviderName, account: string, scope: string) {
  const s = stateOf(p, account, scope);
  return { lastOkAt: s.lastOkAt || null, lastFailAt: s.lastFailAt || null, lastError: s.lastError, active: s.active };
}

/** Refresh the shared cooldowns (at most every 15 s per instance; failures keep the last copy). */
export async function syncShared(p: ProviderName, now = Date.now()): Promise<void> {
  const cur = shared.get(p);
  if (cur && now - cur.at < SHARED_TTL_MS) return;
  shared.set(p, { at: now, entries: cur?.entries ?? {}, raw: cur?.raw ?? {} });
  if (!adminConfigured()) return;
  try {
    const doc = await (await adminDb()).get<Record<string, unknown>>(`providerHealth/${p}`);
    const entries: Record<string, Cooldown> = {};
    for (const [k, v] of Object.entries(doc?.data ?? {})) {
      const c = v as Partial<Cooldown> | null;
      if (c && typeof c.until === 'number' && typeof c.reason === 'string') entries[k] = { until: c.until, reason: c.reason as CooldownReason };
    }
    shared.set(p, { at: now, entries, raw: doc?.data ?? {} });
  } catch {
    /* keep the last known copy */
  }
}

/** Everything in the shared health document (cooldowns and notes such as learned quota values). */
export function sharedRaw(p: ProviderName): Record<string, unknown> {
  return shared.get(p)?.raw ?? {};
}

/** Shared cooldown entries for the dashboard (account__model -> cooldown). */
export async function sharedCooldowns(p: ProviderName): Promise<Record<string, Cooldown>> {
  await syncShared(p, Date.now() + SHARED_TTL_MS);
  return shared.get(p)?.entries ?? {};
}

async function persist(p: ProviderName, fields: Record<string, unknown>) {
  if (!adminConfigured()) return;
  try {
    await (await adminDb()).set(`providerHealth/${p}`, { ...fields, updatedAt: SERVER_TIME }, true);
  } catch (err) {
    console.warn(`[accounts] could not share ${p} health:`, err instanceof Error ? err.message : err);
  }
}

/** Store something learned about an account (for example a quota value Google reported). */
export function persistNote(p: ProviderName, fields: Record<string, unknown>) {
  void persist(p, fields);
}

export interface ProviderEvent {
  provider: ProviderName;
  account: string;
  kind: 'cooldown' | 'switch' | 'auth';
  reason: string;
  model?: string | null;
  /** for a switch: the account that took over */
  to?: string | null;
  until?: number | null;
  error?: string | null;
}

let seq = 0;
/** Record an event for the administrator dashboard (never credentials or request text). */
export async function logEvent(e: ProviderEvent, now = Date.now()) {
  if (!adminConfigured()) return;
  try {
    const id = `${now.toString(36)}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await (await adminDb()).set(`providerEvents/${id}`, { ...e, at: now, createdAt: SERVER_TIME });
  } catch {
    /* monitoring only */
  }
}

/** Forget one provider's cooldowns on this instance (tests, and the shared copy is re-read). */
export function clearCooldowns(p: ProviderName) {
  for (const k of [...cool.keys()]) if (k.startsWith(p + '|')) cool.delete(k);
  for (const k of [...local.keys()]) if (k.startsWith(p + '|')) local.delete(k);
  shared.delete(p);
}

/** for tests */
export function resetAccountHealth() {
  local.clear();
  cool.clear();
  shared.clear();
}
