/**
 * Request logs and analytics counters of the API platform.
 *
 * A log row records only who called (integration and key ids), what (method, endpoint, feature),
 * the outcome (HTTP status, error code), time taken, environment and model. Never a prompt, reply,
 * document, recording, raw key, token, password or OTP, and never the application's raw user id.
 *
 * Analytics come from the day documents apiStats/d-YYYY-MM-DD (written by the request counter in
 * limits.ts and once more here with the outcome), so the dashboard reads one document per day.
 */
import type { Firestore } from '../firestore.js';
import { utcDay } from '../environments/index.js';
import type { ApiFeature, ApiLogRow, KeyMode } from '../shared/apiPlatform.js';
import type { EnvId } from '../shared/environments.js';
import { CONC, dayStatsPath, IDEM, RATE } from './limits.js';
import { newId } from './keys.js';
import { integrationPath, keyPath, LOGS } from './store.js';

export const LOG_RETENTION_DAYS = 30;

export interface Outcome {
  integrationId: string;
  keyId: string | null;
  mode: KeyMode | null;
  method: string;
  endpoint: string;
  feature: ApiFeature;
  status: number;
  code: string | null;
  ms: number;
  environment: EnvId | 'mixed' | null;
  model: string | null;
  requestId: string;
  source: 'api' | 'admin_test';
  /** the request counted against the rate limits (false when refused before counting) */
  counted: boolean;
  providerError: boolean;
}

/** Endpoints are logged as patterns ("/v1/conversations/:id"), never with ids or query strings. */
export function endpointPattern(segments: string[]): string {
  const parts = segments.map((s, i) => (i > 0 && !/^(analyze|speech|transcriptions)$/.test(s) ? ':id' : s));
  return `/v1/${parts.join('/')}`.slice(0, 80);
}

/** Record the outcome of one request: a log row and the day's outcome counters. */
export async function recordOutcome(db: Firestore, o: Outcome, now = Date.now()): Promise<void> {
  const id = newId('log', 10);
  const row: ApiLogRow & { expiresAt: string; day: string } = {
    id,
    at: now,
    integrationId: o.integrationId,
    keyId: o.keyId,
    mode: o.mode,
    method: o.method,
    endpoint: o.endpoint,
    feature: o.feature,
    status: o.status,
    code: o.code,
    ms: Math.max(0, Math.round(o.ms)),
    environment: o.environment,
    model: o.model ? o.model.slice(0, 120) : null,
    requestId: o.requestId,
    source: o.source,
    day: utcDay(now),
    expiresAt: new Date(now + LOG_RETENTION_DAYS * 86_400_000).toISOString(),
  };
  const ok = o.status < 400;
  const inc: Record<string, number> = {};
  const add = (k: string, n = 1) => (inc[k] = (inc[k] ?? 0) + n);
  const hour = `h${new Date(now).toISOString().slice(11, 13)}`;
  const scopes = ['total', ...(o.integrationId ? [`apps.${o.integrationId}`] : []), ...(o.keyId ? [`keys.${o.keyId}`] : [])];
  for (const s of scopes) {
    add(`${s}.${ok ? 'ok' : 'failed'}`);
    add(`${s}.ms`, row.ms);
    if (o.status === 429) add(`${s}.rateLimited`);
    if (o.status === 403 && o.code === 'permission_denied') add(`${s}.denied`);
    if (o.providerError) add(`${s}.providerErrors`);
  }
  // breakdowns (the total and per application)
  for (const s of scopes.slice(0, 2)) {
    add(`${s}.f.${o.feature}.n`);
    if (!ok) add(`${s}.f.${o.feature}.failed`);
    if (o.environment) add(`${s}.e.${o.environment}`);
    add(`${s}.t.${hour}.n`);
    if (!ok) add(`${s}.t.${hour}.failed`);
    add(`${s}.s.c${o.status}`);
  }
  // requests refused before they were counted (rate limits, authentication) still show up
  if (!o.counted) add('total.uncounted');
  const writes: Promise<unknown>[] = [db.incrementAndGet(dayStatsPath(row.day), inc, { period: 'day', key: row.day })];
  if (o.integrationId) writes.push(db.set(`${LOGS}/${id}`, row));
  await Promise.all(writes);
}

/* ------------------------------------------------------------- last-used times */

const LAST_USED_EVERY = 10 * 60_000;
const lastUsed = new Map<string, number>();

/** Update lastUsedAt on the integration and key at most every 10 minutes per instance. */
export async function touchLastUsed(db: Firestore, integrationId: string, keyId: string, now = Date.now()): Promise<void> {
  const prev = lastUsed.get(keyId) ?? 0;
  if (now - prev < LAST_USED_EVERY) return;
  lastUsed.set(keyId, now);
  if (lastUsed.size > 5_000) lastUsed.clear();
  await Promise.all([db.set(integrationPath(integrationId), { lastUsedAt: now }, true), db.set(keyPath(keyId), { lastUsedAt: now }, true)]);
}

/* ---------------------------------------------------------------------- pruning */

/**
 * Daily clean-up (cron): logs past their retention, finished idempotency records and spent
 * rate-limit and concurrency counters. Day/month analytics are kept (one small document each).
 */
export async function pruneApiRecords(db: Firestore, now = Date.now()): Promise<Record<string, number>> {
  const iso = new Date(now).toISOString();
  const out: Record<string, number> = {};
  for (const coll of [LOGS, IDEM, RATE, CONC]) {
    let n = 0;
    for (let page = 0; page < 10; page++) {
      const rows = await db.list(coll, { where: [['expiresAt', 'LESS_THAN', iso]], limit: 300 });
      if (!rows.length) break;
      await db.commit(rows.map((r) => ({ op: 'delete' as const, path: r.path })));
      n += rows.length;
      if (rows.length < 300) break;
    }
    out[coll] = n;
  }
  return out;
}
