/**
 * Gemini accounts: two independent Google projects (A = GEMINI_API_KEY, B = GEMINI_API_KEY_SECONDARY),
 * each with its own free-tier quota per model. Both were verified to be separate projects.
 *
 * Per request (one model), the accounts are tried in order of load:
 *  - skipped: accounts in cooldown for that model (or for every model, e.g. a rejected key),
 *    accounts whose key does not list the model, and accounts at Atlas's per-minute guard
 *    (80% of the published RPM, counted on this instance);
 *  - first: the account with the lowest use of its known limits (per-minute window, today's
 *    requests against the per-day quota), ties alternating so neither account sits idle;
 *  - per-day quota: where Google's daily limit is known, a request is counted atomically in
 *    `geminiUsage/{Pacific day}` before it is sent; a count past the limit is undone and the
 *    account rests until midnight Pacific time (when Google resets it).
 *
 * A rate limit, outage, rejected key or missing model moves the request to the other account
 * (only before any text was streamed, so one request gives one answer). When every account is
 * unavailable the error goes to the chat engine, which continues with the next approved free
 * model (Gemini, then OpenRouter ":free"). Paid models are never involved: the Free Models Only
 * policy (billing/policy.ts) is checked before any account is chosen.
 */
import { adminConfigured, adminDb } from '../admin.js';
import { GEMINI_LIMITS, nextPacificMidnight, pacificDay, rpmGuard, type ModelLimits } from '../config/providerLimits.js';
import { environmentDisabled, envOf, geminiCredentials } from '../environments/index.js';
import { fieldPath, SERVER_TIME } from '../firestore.js';
import * as H from './accountHealth.js';
import { ProviderError } from './types.js';

/** A and B: the Main pool (Secondary is B alone); T: the Temporary public-testing project. */
export type GeminiAccountId = 'A' | 'B' | 'T';
export interface GeminiAccount {
  id: GeminiAccountId;
  key: string;
}

/**
 * The accounts of the API environment this request runs in (server/environments): Main = A and B,
 * Secondary = B, Temporary = T. Never another environment's keys: an environment that is switched
 * off or has no key has no accounts, and Gemini is then unavailable for the request.
 */
export function geminiAccounts(): GeminiAccount[] {
  let e;
  try {
    e = envOf('gemini');
  } catch {
    return []; // the environment settings could not be read: no guessing
  }
  if (environmentDisabled('gemini', e)) return [];
  return geminiCredentials(e);
}

const KEY_VARIABLE: Record<GeminiAccountId, string> = { A: 'GEMINI_API_KEY', B: 'GEMINI_API_KEY_SECONDARY', T: 'GEMINI_API_KEY_TEMPORARY' };

export const modelKey = (model: string) => model.replace(/[^A-Za-z0-9_]/g, '_');
export const geminiUsagePath = (day = pacificDay()) => `geminiUsage/${day}`;

/* ------------------------------ what each account offers ------------------------------ */

const offered = new Map<string, Set<string>>();
/** Record the models an account's key lists (from its own models endpoint). */
export function setAccountModels(account: string, ids: string[]) {
  offered.set(account, new Set(ids));
}
export function accountModels(account: string): string[] | null {
  const s = offered.get(account);
  return s ? [...s] : null;
}

/* ------------------------------------- limits ------------------------------------- */

const learned = new Map<string, ModelLimits>();
const limitNote = (account: string, model: string) => `limits__${account}__${modelKey(model)}`;

/** Limits for one account and model: what Google reported for it, else the verified defaults. */
export function limitsFor(account: string, model: string): ModelLimits & { source: 'reported' | 'default' | 'unknown' } {
  const fromShared = H.sharedRaw('gemini')[limitNote(account, model)] as ModelLimits | undefined;
  const got = { ...(fromShared ?? {}), ...(learned.get(`${account}|${model}`) ?? {}) };
  const base = GEMINI_LIMITS[model];
  if (got.rpd || got.rpm) return { ...base, ...got, source: 'reported' };
  return base ? { ...base, source: 'default' } : { source: 'unknown' };
}

function learn(account: string, model: string, quota: ProviderError['quota']) {
  if (!quota || quota.value === null || quota.value <= 0) return;
  const k = `${account}|${model}`;
  const next = { ...(learned.get(k) ?? {}), ...(quota.perDay ? { rpd: quota.value } : /PerMinute/i.test(quota.id) && !/Token/i.test(quota.id) ? { rpm: quota.value } : {}) };
  learned.set(k, next);
  H.persistNote('gemini', { [limitNote(account, model)]: next });
}

/* ------------------------------------ ordering ------------------------------------ */

const dayCounts = new Map<string, { day: string; n: number }>();
let rr = 0;

function score(account: GeminiAccountId, model: string, now: number): number {
  const lim = limitsFor(account, model);
  const guard = rpmGuard(lim);
  const { lastMinute, active } = H.load('gemini', account, model, now);
  const minute = guard ? lastMinute / guard : lastMinute / 100;
  const dc = dayCounts.get(`${account}|${model}`);
  const day = lim.rpd && dc && dc.day === pacificDay(now) ? dc.n / lim.rpd : 0;
  return Math.max(minute, day) + active * 0.05;
}

/**
 * True when every Gemini account is resting for this model (a timeout, outage, rate limit or used-up
 * daily quota, on this instance or reported by another one through the shared cooldowns). The chat
 * engine then tries the next model first instead of waiting for this one.
 */
export function geminiModelResting(modelId: string, now = Date.now()): boolean {
  if (!modelId.startsWith('gemini:')) return false;
  const model = modelId.slice('gemini:'.length);
  const accounts = geminiAccounts();
  return accounts.length > 0 && accounts.every((a) => H.cooldownOf('gemini', a.id, model, now) !== null);
}

/** Usable accounts for this model, least loaded first (ties alternate). */
export function orderAccounts(model: string, now = Date.now()): GeminiAccount[] {
  const list = geminiAccounts().filter((a) => {
    const models = offered.get(a.id);
    return (!models || models.has(model)) && !H.cooldownOf('gemini', a.id, model, now);
  });
  const flip = rr++ % 2 === 1;
  return list
    .map((a, i) => ({ a, s: score(a.id, model, now), tie: flip ? -i : i }))
    .sort((x, y) => x.s - y.s || x.tie - y.tie)
    .map((x) => x.a);
}

/* ----------------------------- per-day atomic counting ----------------------------- */

/** Count this request for today; false (and the account rests) when the daily quota is used up. */
async function reserveDay(account: GeminiAccount, model: string, now: number): Promise<boolean> {
  if (!adminConfigured()) return true;
  const lim = limitsFor(account.id, model);
  const day = pacificDay(now);
  const field = fieldPath(account.id, modelKey(model), 'requests');
  try {
    const db = await adminDb();
    if (!lim.rpd) {
      // no known daily limit: count for the dashboard without delaying the request
      void db.commit([{ op: 'increment', path: geminiUsagePath(day), increments: { [field]: 1 }, data: { date: day } }]).catch(() => undefined);
      return true;
    }
    const n = (await db.incrementAndGet(geminiUsagePath(day), { [field]: 1 }, { date: day }))[field];
    dayCounts.set(`${account.id}|${model}`, { day, n });
    if (n > lim.rpd) {
      await db.incrementAndGet(geminiUsagePath(day), { [field]: -1 }).catch(() => undefined);
      H.startCooldown('gemini', account.id, model, nextPacificMidnight(now) - now, 'rpd', { model, error: 'daily_quota' }, now);
      return false;
    }
    return true;
  } catch {
    // the counter is unreachable: let Google's own limit decide (free tier, so no cost either way)
    return true;
  }
}

function record(account: GeminiAccountId, model: string, outcome: 'ok' | 'failed' | 'rateLimited', opts: { switched?: boolean; error?: string } = {}) {
  if (!adminConfigured()) return;
  const day = pacificDay();
  const increments: Record<string, number> = { [fieldPath(account, modelKey(model), outcome)]: 1 };
  if (opts.switched) increments[fieldPath(account, 'switchedTo')] = 1;
  const data: Record<string, unknown> = { date: day, updatedAt: SERVER_TIME };
  if (outcome === 'ok') data[`lastOk_${account}`] = SERVER_TIME;
  else {
    data[`lastFail_${account}`] = SERVER_TIME;
    data[`lastError_${account}`] = opts.error ?? outcome;
  }
  void adminDb()
    .then((db) => db.commit([{ op: 'increment', path: geminiUsagePath(day), increments, data }]))
    .catch(() => undefined);
}

/* ------------------------------------ attempts ------------------------------------ */

export interface AttemptState {
  errors: unknown[];
  /** an account was skipped because Atlas's per-minute guard was reached */
  paced: boolean;
  /** the account that failed last (for the switch event) */
  failedFrom: GeminiAccountId | null;
}
export const newAttemptState = (): AttemptState => ({ errors: [], paced: false, failedFrom: null });

export interface Lease {
  account: GeminiAccount;
  /** the request succeeded on this account */
  ok(): void;
  /** the request failed here: 'next' tries the other account, 'stop' gives the error to the caller */
  fail(err: unknown): 'next' | 'stop';
  end(): void;
}

const MIN = 60_000;

/** Classify a failure, update the account's health, and say whether another account may help. */
function onFailure(account: GeminiAccountId, model: string, err: unknown, now = Date.now()): 'next' | 'stop' {
  if (!(err instanceof ProviderError)) return 'stop'; // aborted by the user, or a bug: never retried elsewhere
  const streak = () => H.failureStreak('gemini', account, model);
  switch (err.code) {
    case 'rate_limited':
      H.noteFailure('gemini', account, model, 'rate_limited', now);
      learn(account, model, err.quota);
      H.startCooldown('gemini', account, model, H.backoffMs(streak(), MIN, 15 * MIN, err.retryAfterMs), 'rpm', { model, error: 'rate_limited' }, now);
      record(account, model, 'rateLimited', { error: 'rate_limited' });
      return 'next';
    case 'daily_limit':
      H.noteFailure('gemini', account, model, 'daily_limit', now);
      learn(account, model, err.quota);
      H.startCooldown('gemini', account, model, nextPacificMidnight(now) - now, 'rpd', { model, error: 'daily_limit' }, now);
      record(account, model, 'rateLimited', { error: 'daily_limit' });
      return 'next';
    case 'invalid_key':
      // a configuration problem: alert, rest the whole account, never retry it in a loop
      H.noteFailure('gemini', account, H.ANY_MODEL, 'invalid_key', now);
      console.error(`[gemini] Google refused account ${account} (${err.message}) Check its server setting (${KEY_VARIABLE[account]}).`);
      H.startCooldown('gemini', account, H.ANY_MODEL, 10 * MIN, 'auth', { error: 'invalid_key' }, now);
      void H.logEvent({ provider: 'gemini', account, kind: 'auth', reason: 'invalid_key' });
      record(account, model, 'failed', { error: 'invalid_key' });
      return 'next';
    case 'model_unavailable':
      H.noteFailure('gemini', account, model, 'model_unavailable', now);
      H.startCooldown('gemini', account, model, 10 * MIN, 'unavailable', { model, error: 'model_unavailable' }, now);
      record(account, model, 'failed', { error: 'model_unavailable' });
      return 'next';
    case 'timeout':
    case 'provider_error':
      H.noteFailure('gemini', account, model, err.code, now);
      // a model that hangs tends to keep hanging: rest it longer (2, 4, 8 ... up to 30 min), shared
      // with every instance, so users don't each wait for it; one success ends the streak
      H.startCooldown(
        'gemini',
        account,
        model,
        err.code === 'timeout' ? H.backoffMs(streak(), 2 * MIN, 30 * MIN) : H.backoffMs(streak(), 30_000, 5 * MIN),
        'outage',
        { model, error: err.code },
        now,
      );
      record(account, model, 'failed', { error: err.code });
      return 'next';
    case 'not_configured':
      return 'next';
    default:
      // bad request, too long, moderation: the other project would answer the same way
      record(account, model, 'failed', { error: err.code });
      return 'stop';
  }
}

/** Accounts to try for one request, in order. Consume with `for await` and stop on success. */
export async function* leases(model: string, state: AttemptState): AsyncGenerator<Lease> {
  await H.syncShared('gemini');
  const order = orderAccounts(model);
  for (const account of order) {
    const now = Date.now();
    if (H.cooldownOf('gemini', account.id, model, now)) continue; // set by an earlier attempt of this request
    const guard = rpmGuard(limitsFor(account.id, model));
    if (guard !== null && H.load('gemini', account.id, model, now).lastMinute >= guard) {
      state.paced = true;
      continue;
    }
    // counted before the (async) daily check, so parallel requests see each other at the guard
    const end = H.begin('gemini', account.id, model, now);
    if (!(await reserveDay(account, model, now))) {
      end();
      H.unstart('gemini', account.id, model, now);
      continue;
    }
    const from = state.failedFrom;
    yield {
      account,
      ok() {
        H.noteSuccess('gemini', account.id, model);
        record(account.id, model, 'ok', { switched: from !== null });
        if (from !== null) void H.logEvent({ provider: 'gemini', account: from, to: account.id, kind: 'switch', reason: 'failover', model });
      },
      fail(err) {
        const r = onFailure(account.id, model, err);
        if (r === 'next') state.failedFrom = account.id;
        return r;
      },
      end,
    };
  }
}

/** The error to report when no account could serve the request. */
export function exhaustedError(model: string, state: AttemptState): ProviderError {
  const errors = state.errors.filter((e): e is ProviderError => e instanceof ProviderError);
  const limitCodes = new Set(['rate_limited', 'daily_limit']);
  if (errors.length && errors.every((e) => e.code === 'daily_limit')) return errors[errors.length - 1];
  if (errors.some((e) => limitCodes.has(e.code)) || state.paced || !errors.length) {
    if (!geminiAccounts().length) return new ProviderError('not_configured', 'Gemini is not available in the current API environment.', 503);
    const reasons = geminiAccounts().map((a) => H.cooldownOf('gemini', a.id, model)?.reason);
    if (!errors.length && !state.paced && reasons.every((r) => r === 'rpd'))
      return new ProviderError('daily_limit', 'The Gemini free-tier daily quota for this model is used up. It resets at midnight Pacific time.', 429);
    if (!errors.length && !state.paced && reasons.every((r) => r === 'auth'))
      return new ProviderError('invalid_key', 'Google rejected the Gemini API key.', 401);
    // every account is resting after timeouts or errors: not a quota problem, say so
    if (!errors.length && !state.paced && reasons.every((r) => r === 'outage' || r === 'unavailable'))
      return new ProviderError('timeout', 'This Gemini model is not responding at the moment.', 504);
    return new ProviderError('rate_limited', 'The Gemini free-tier quota for this model is used up for now.', 429);
  }
  return errors[errors.length - 1];
}

/** Run one non-streaming call on the best available account, moving to the other on a limit or outage. */
export async function withGeminiAccount<T>(model: string, run: (account: GeminiAccount) => Promise<T>): Promise<T> {
  const state = newAttemptState();
  for await (const lease of leases(model, state)) {
    try {
      const out = await run(lease.account);
      lease.ok();
      return out;
    } catch (err) {
      if (lease.fail(err) === 'stop') throw err;
      state.errors.push(err);
    } finally {
      lease.end();
    }
  }
  throw exhaustedError(model, state);
}

/** for tests */
export function resetGeminiAccounts() {
  offered.clear();
  learned.clear();
  dayCounts.clear();
  rr = 0;
}
