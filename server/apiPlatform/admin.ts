/**
 * Super Admin API Management (POST /api/admin {action:'apiManagement', op}). The caller is checked
 * in api/admin.ts (Super Admin only); every change is written to the admin log (adminLogs) and to
 * apiAudit with the previous and new configuration and whether it succeeded.
 *
 * A full API key is returned exactly once, in the response that created it (create, keyCreate,
 * keyRotate). Only its SHA-256 hash is stored; nobody, the Super Admin included, can see it again.
 */
import { z } from 'zod';
import { eventId, recordAdminAction, type AdminAction } from '../account/events.js';
import type { Actor } from '../account/lifecycle.js';
import { utcDay, utcMonth } from '../environments/index.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import {
  API_FEATURES,
  API_PERMISSIONS,
  APP_TYPES,
  cleanPermissions,
  ENV_CHOICES,
  INTEGRATION_STATUSES,
  LIMIT_KEYS,
  normalizeIntegration,
  normalizeKeyLimits,
  normalizeLimits,
  normalizeOrigin,
  USAGE_PROFILES,
  type ApiLogRow,
  type IntegrationConfig,
} from '../shared/apiPlatform.js';
import { ENVIRONMENTS } from '../shared/environments.js';
import { checkIntegration } from './auth.js';
import { generateKey, newId } from './keys.js';
import { childIds, dayStatsPath, monthStatsPath, readNum } from './limits.js';
import { handleV1 } from './router.js';
import { AUDIT, integrationPath, keyPath, keyView, listIntegrations, listKeys, loadIntegration, loadKey, LOGS, type KeyRecord } from './store.js';

/* ---------------------------------------------------------------------- schemas */

const intId = z.string().regex(/^int_[a-f0-9]{16}$/);
const keyId = z.string().regex(/^key_[a-f0-9]{16}$/);
const limitValue = z.number().int().min(0).max(100_000_000).nullable();
const limitsSchema = z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<(typeof LIMIT_KEYS)[number], z.ZodOptional<typeof limitValue>>).extend({ streaming: z.boolean().optional() }).strict();
const keyLimitsSchema = z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<(typeof LIMIT_KEYS)[number], z.ZodOptional<typeof limitValue>>).strict();
const expiry = z.number().int().positive().nullable();

export const integrationInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    appName: z.string().trim().max(80).default(''),
    appDescription: z.string().trim().max(500).default(''),
    appType: z.enum(APP_TYPES),
    status: z.enum(INTEGRATION_STATUSES).default('active'),
    permissions: z.array(z.enum(API_PERMISSIONS)).max(API_PERMISSIONS.length).default([]),
    profile: z.enum(USAGE_PROFILES).default('standard'),
    limits: limitsSchema.optional(),
    expiresAt: expiry.default(null),
    allowedEnvironments: z.array(z.enum(ENVIRONMENTS)).min(1).max(ENVIRONMENTS.length),
    environment: z.object({ live: z.enum(ENV_CHOICES as [string, ...string[]]), test: z.enum(ENV_CHOICES as [string, ...string[]]) }).default({ live: 'active', test: 'active' }),
    allowedModels: z.array(z.string().min(1).max(200)).max(50).nullable().default(null),
    allowedOrigins: z.array(z.string().max(200)).max(20).default([]),
  })
  .strict();
type IntegrationInput = z.infer<typeof integrationInput>;

const activityFilter = z
  .object({
    integrationId: intId.optional(),
    keyId: keyId.optional(),
    feature: z.enum(API_FEATURES).optional(),
    environment: z.enum([...ENVIRONMENTS, 'mixed']).optional(),
    status: z.enum(['success', 'failed', 'rate_limited', 'denied', 'provider_error']).optional(),
    from: z.number().int().positive().optional(),
    to: z.number().int().positive().optional(),
    source: z.enum(['api', 'admin_test']).optional(),
  })
  .strict();

const TEST_ENDPOINTS = [
  'app',
  'models',
  'chat',
  'chat_stream',
  'research_search',
  'research_answer',
  'images',
  'documents_list',
  'documents_upload',
  'conversations_list',
  'memory_list',
  'voice_speech',
] as const;

export const apiManagementOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('overview') }),
  z.object({ op: z.literal('list') }),
  z.object({ op: z.literal('get'), id: intId }),
  z.object({ op: z.literal('create'), config: integrationInput, firstKey: z.object({ name: z.string().trim().min(1).max(80), mode: z.enum(['live', 'test']) }).optional() }),
  z.object({ op: z.literal('update'), id: intId, config: integrationInput, version: z.number().int().min(0) }),
  z.object({ op: z.literal('setStatus'), id: intId, status: z.enum(INTEGRATION_STATUSES) }),
  z.object({ op: z.literal('delete'), id: intId, confirmName: z.string().max(80) }),
  z.object({ op: z.literal('keyCreate'), integrationId: intId, name: z.string().trim().min(1).max(80), mode: z.enum(['live', 'test']), expiresAt: expiry.default(null), limits: keyLimitsSchema.nullable().default(null) }),
  z.object({ op: z.literal('keyRotate'), keyId, graceMinutes: z.number().int().min(0).max(10_080).default(0) }),
  z.object({ op: z.literal('keyRevoke'), keyId }),
  z.object({ op: z.literal('keySetStatus'), keyId, status: z.enum(['active', 'disabled']) }),
  z.object({ op: z.literal('keyUpdate'), keyId, name: z.string().trim().min(1).max(80), expiresAt: expiry, limits: keyLimitsSchema.nullable() }),
  z.object({ op: z.literal('activity'), filter: activityFilter.default({}) }),
  z.object({ op: z.literal('analytics'), days: z.number().int().min(1).max(90).default(14), integrationId: intId.optional() }),
  z.object({ op: z.literal('audit'), integrationId: intId.optional() }),
  z.object({
    op: z.literal('test'),
    integrationId: intId,
    keyId,
    endpoint: z.enum(TEST_ENDPOINTS),
    input: z.string().max(4_000).default(''),
    model: z.string().max(200).optional(),
    endUser: z.string().max(128).optional(),
  }),
]);
export type ApiManagementOp = z.infer<typeof apiManagementOpSchema>;

/* ---------------------------------------------------------------------- helpers */

interface Deps {
  db: Firestore;
  actor: Actor;
  now?: number;
}

/** The stored form of an integration from validated input (invalid combinations refused). */
function toStored(input: IntegrationInput): Omit<IntegrationConfig, 'id' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'version' | 'lastUsedAt'> {
  const origins: string[] = [];
  for (const o of input.allowedOrigins) {
    const n = normalizeOrigin(o);
    if (!n) throw new HttpError(400, 'bad_origin', `Not a valid website origin: ${o.slice(0, 80)} (use https://example.com).`);
    if (!origins.includes(n)) origins.push(n);
  }
  const allowed = ENVIRONMENTS.filter((e) => input.allowedEnvironments.includes(e));
  for (const mode of ['live', 'test'] as const) {
    const c = input.environment[mode];
    if (c !== 'active' && !allowed.includes(c as (typeof allowed)[number])) {
      throw new HttpError(400, 'bad_environment', `The ${mode} keys’ environment must be one of the allowed environments.`);
    }
  }
  const permissions = cleanPermissions(input.permissions);
  const dropped = input.permissions.filter((p) => !permissions.includes(p));
  if (dropped.length) throw new HttpError(400, 'bad_permissions', `These permissions need another one that is not selected: ${dropped.join(', ')}.`);
  return {
    name: input.name,
    appName: input.appName,
    appDescription: input.appDescription,
    appType: input.appType,
    status: input.status,
    permissions,
    profile: input.profile,
    limits: normalizeLimits(input.profile, input.limits ?? {}),
    expiresAt: input.expiresAt,
    allowedEnvironments: allowed,
    environment: input.environment as IntegrationConfig['environment'],
    allowedModels: input.allowedModels?.length ? [...new Set(input.allowedModels)] : null,
    allowedOrigins: origins,
  };
}

const KEY_LIMIT_MAX = 25;

async function audit(
  deps: Deps,
  entry: { action: AdminAction; integrationId: string; keyId?: string | null; before: unknown; after: unknown; success: boolean; error?: string | null; detail?: string },
) {
  const now = deps.now ?? Date.now();
  await Promise.all([
    deps.db.set(`${AUDIT}/${eventId(now)}`, {
      action: entry.action,
      integrationId: entry.integrationId,
      keyId: entry.keyId ?? null,
      adminUid: deps.actor.uid,
      adminEmail: deps.actor.email,
      before: entry.before ?? null,
      after: entry.after ?? null,
      success: entry.success,
      error: entry.error ?? null,
      at: now,
    }),
    entry.success
      ? recordAdminAction(
          deps.db,
          {
            action: entry.action,
            adminUid: deps.actor.uid,
            adminEmail: deps.actor.email,
            targetUid: entry.integrationId,
            targetEmail: null,
            detail: entry.detail,
            changes: { before: entry.before ?? null, after: entry.after ?? null },
          },
          now,
        )
      : Promise.resolve(),
  ]).catch((err) => console.warn('[api-admin] audit write failed', err instanceof Error ? err.message : err));
}

/** Run a change and audit it, whether it succeeds or not. */
async function audited<T>(deps: Deps, base: { action: AdminAction; integrationId: string; keyId?: string | null; before: unknown; detail?: string }, run: () => Promise<{ result: T; after: unknown }>): Promise<T> {
  try {
    const { result, after } = await run();
    await audit(deps, { ...base, after, success: true });
    return result;
  } catch (err) {
    await audit(deps, { ...base, after: null, success: false, error: err instanceof HttpError ? err.code : 'error' });
    throw err;
  }
}

async function mustIntegration(db: Firestore, id: string): Promise<IntegrationConfig> {
  const i = await loadIntegration(db, id);
  if (!i || i.status === 'deleted') throw new HttpError(404, 'not_found', 'Integration not found.');
  return i;
}

async function mustKey(db: Firestore, id: string): Promise<KeyRecord> {
  const k = await loadKey(db, id);
  if (!k) throw new HttpError(404, 'not_found', 'Key not found.');
  return k;
}

/** Configuration as shown in the audit trail (no secrets exist in it). */
const snapshot = (i: IntegrationConfig) => {
  const { lastUsedAt: _l, ...rest } = i;
  void _l;
  return rest;
};
const keySnapshot = (k: KeyRecord) => {
  const { hash: _h, lastUsedAt: _l, ...rest } = k;
  void _h;
  void _l;
  return rest;
};

async function newKeyRecord(db: Firestore, integrationId: string, input: { name: string; mode: 'live' | 'test'; expiresAt: number | null; limits: unknown; rotatedFrom?: string | null }, actor: Actor, now: number) {
  const existing = await listKeys(db, integrationId);
  if (existing.filter((k) => k.status !== 'revoked').length >= KEY_LIMIT_MAX) throw new HttpError(409, 'too_many_keys', `An integration can have at most ${KEY_LIMIT_MAX} keys that are not revoked.`);
  const k = generateKey(input.mode);
  const record: KeyRecord = {
    id: k.keyId,
    integrationId,
    name: input.name,
    mode: input.mode,
    hash: k.hash,
    display: k.display,
    status: 'active',
    expiresAt: input.expiresAt,
    limits: normalizeKeyLimits(input.limits),
    createdAt: now,
    createdBy: actor.email ?? actor.uid,
    lastUsedAt: null,
    revokedAt: null,
    rotatedFrom: input.rotatedFrom ?? null,
    rotatedTo: null,
  };
  await db.commit([{ op: 'set', path: keyPath(k.keyId), data: record, precondition: { exists: false } }]);
  return { record, secret: k.secret };
}

/* --------------------------------------------------------------------- analytics */

const dayKeys = (days: number, now: number) => Array.from({ length: days }, (_, i) => utcDay(now - (days - 1 - i) * 86_400_000));

function avg(ms: number, n: number) {
  return n ? Math.round(ms / n) : 0;
}

async function analytics(db: Firestore, days: number, integrationId: string | undefined, now: number) {
  const keys = dayKeys(days, now);
  const docs = await db.getMany<Record<string, unknown>>(keys.map((d) => dayStatsPath(d)));
  const byDay = new Map(docs.map((d) => [d.id.slice(2), d.data]));
  const scope = integrationId ? `apps.${integrationId}` : 'total';
  const series = keys.map((day) => {
    const d = byDay.get(day);
    const ok = readNum(d, `${scope}.ok`);
    const failed = readNum(d, `${scope}.failed`);
    return {
      day,
      requests: ok + failed,
      ok,
      failed,
      avgMs: avg(readNum(d, `${scope}.ms`), ok + failed),
      rateLimited: readNum(d, `${scope}.rateLimited`),
      denied: readNum(d, `${scope}.denied`),
      providerErrors: readNum(d, `${scope}.providerErrors`),
    };
  });
  const sumOver = (path: (d: Record<string, unknown> | undefined) => number) => keys.reduce((n, k) => n + path(byDay.get(k)), 0);
  const features = API_FEATURES.map((f) => ({ feature: f, requests: sumOver((d) => readNum(d, `${scope}.f.${f}.n`)), failed: sumOver((d) => readNum(d, `${scope}.f.${f}.failed`)) })).filter((r) => r.requests);
  const environments = [...ENVIRONMENTS, 'mixed'].map((e) => ({ environment: e, requests: sumOver((d) => readNum(d, `${scope}.e.${e}`)) })).filter((r) => r.requests);
  const statuses = new Map<string, number>();
  for (const k of keys) {
    const d = byDay.get(k);
    for (const c of childIds(d, `${scope}.s`)) statuses.set(c.slice(1), (statuses.get(c.slice(1)) ?? 0) + readNum(d, `${scope}.s.${c}`));
  }
  // per application and per key (all apps, or the keys of one app)
  const appIds = new Set<string>();
  const keyIds = new Set<string>();
  for (const k of keys) {
    childIds(byDay.get(k), 'apps').forEach((a) => appIds.add(a));
    childIds(byDay.get(k), 'keys').forEach((a) => keyIds.add(a));
  }
  const apps = integrationId
    ? []
    : [...appIds].map((a) => ({ integrationId: a, requests: sumOver((d) => readNum(d, `apps.${a}.ok`) + readNum(d, `apps.${a}.failed`)), failed: sumOver((d) => readNum(d, `apps.${a}.failed`)) })).sort((x, y) => y.requests - x.requests);
  let keyRows = [...keyIds].map((k) => ({ keyId: k, requests: sumOver((d) => readNum(d, `keys.${k}.ok`) + readNum(d, `keys.${k}.failed`)), failed: sumOver((d) => readNum(d, `keys.${k}.failed`)) }));
  if (integrationId) {
    const own = new Set((await listKeys(db, integrationId)).map((k) => k.id));
    keyRows = keyRows.filter((k) => own.has(k.keyId));
  }
  const today = byDay.get(utcDay(now));
  const hourly = Array.from({ length: 24 }, (_, h) => {
    const hh = `h${String(h).padStart(2, '0')}`;
    return { hour: h, requests: readNum(today, `${scope}.t.${hh}.n`), failed: readNum(today, `${scope}.t.${hh}.failed`) };
  });
  const units = integrationId
    ? Object.fromEntries(['images', 'research', 'deep_research', 'documents', 'tts_chars', 'stt'].map((u) => [u, sumOver((d) => readNum(d, `apps.${integrationId}.u.${u}`))]))
    : null;
  return { days, series, hourly, features, environments, statuses: [...statuses].map(([status, n]) => ({ status: Number(status), requests: n })).sort((a, b) => a.status - b.status), apps, keys: keyRows.sort((x, y) => y.requests - x.requests), units };
}

async function activity(db: Firestore, f: z.infer<typeof activityFilter>, now: number) {
  const from = f.from ?? now - 7 * 86_400_000;
  const rows = await db.list<ApiLogRow>(LOGS, { where: [['at', 'GREATER_THAN', from]], orderBy: 'at', direction: 'DESCENDING', limit: 1_000 });
  const out = rows
    .map((r) => r.data)
    .filter((r) => {
      if (f.to && r.at > f.to) return false;
      if (f.integrationId && r.integrationId !== f.integrationId) return false;
      if (f.keyId && r.keyId !== f.keyId) return false;
      if (f.feature && r.feature !== f.feature) return false;
      if (f.environment && r.environment !== f.environment) return false;
      if (f.source && r.source !== f.source) return false;
      if (f.status === 'success' && r.status >= 400) return false;
      if (f.status === 'failed' && r.status < 400) return false;
      if (f.status === 'rate_limited' && r.status !== 429) return false;
      if (f.status === 'denied' && r.code !== 'permission_denied') return false;
      if (f.status === 'provider_error' && !(r.code ?? '').startsWith('provider_')) return false;
      return true;
    })
    .slice(0, 300);
  return { rows: out, scanned: rows.length, truncated: rows.length >= 1_000 };
}

/* ------------------------------------------------------------------ test console */

/**
 * Run one API request for an integration from the dashboard. It goes through the real pipeline
 * (permissions, limits, environment, logging) with the chosen key's settings; only the secret is
 * not needed, because the Super Admin is already authenticated. Data goes to a separate test end
 * user unless another one is named.
 */
async function testRequest(deps: Deps, op: Extract<ApiManagementOp, { op: 'test' }>) {
  const integration = checkIntegration(await mustIntegration(deps.db, op.integrationId));
  const key = await mustKey(deps.db, op.keyId);
  if (key.integrationId !== integration.id) throw new HttpError(404, 'not_found', 'Key not found.');
  if (key.status !== 'active') throw new HttpError(409, 'key_not_active', 'This key is not active; choose an active key.');
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) throw new HttpError(409, 'key_expired', 'This key has expired.');

  const input = op.input.trim();
  let method = 'POST';
  let path = '';
  let body: unknown = null;
  switch (op.endpoint) {
    case 'app':
      method = 'GET';
      path = 'app';
      break;
    case 'models':
      method = 'GET';
      path = 'models';
      break;
    case 'chat':
    case 'chat_stream':
      path = 'chat';
      body = { message: input || 'Hello! Reply with one short sentence.', model: op.model || 'auto', stream: op.endpoint === 'chat_stream' };
      break;
    case 'research_search':
      path = 'research';
      body = { query: input || 'latest technology news', mode: 'search' };
      break;
    case 'research_answer':
      path = 'research';
      body = { query: input || 'latest technology news', mode: 'answer' };
      break;
    case 'images':
      path = 'images';
      body = { prompt: input || 'a small lighthouse on a cliff at sunset, watercolour' };
      break;
    case 'documents_list':
      method = 'GET';
      path = 'documents';
      break;
    case 'documents_upload':
      path = 'documents';
      body = { name: 'API test document.txt', text: input || 'This is a short test document created from the API Management test console.' };
      break;
    case 'conversations_list':
      method = 'GET';
      path = 'conversations';
      break;
    case 'memory_list':
      method = 'GET';
      path = 'memory';
      break;
    case 'voice_speech':
      path = 'voice/speech';
      body = { text: input || 'This is a test of the Atlas AI voice.' };
      break;
  }
  const headers: Record<string, string> = { 'x-atlas-user': op.endUser?.trim() || 'admin-test' };
  if (body !== null) headers['content-type'] = 'application/json';
  const request = new Request(`https://api.internal/api/v1/${path}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  const t0 = Date.now();
  const res = await handleV1(request, path, { preauthenticated: { integration, key }, db: deps.db });
  const type = res.headers.get('content-type') ?? '';
  let text: string;
  if (type.startsWith('audio/')) {
    const bytes = (await res.arrayBuffer()).byteLength;
    text = JSON.stringify({ audio: { content_type: type, bytes } });
  } else {
    text = await res.text();
  }
  const ms = Date.now() - t0;
  // large values (image data, long streams) are shortened for display
  const shown = text.replace(/"data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{200,}"/g, (m) => `"${m.slice(1, 60)}… (${m.length} characters)"`).slice(0, 60_000);
  return {
    status: res.status,
    ms,
    contentType: type.split(';')[0],
    rateLimit: { limit: res.headers.get('x-ratelimit-limit'), remaining: res.headers.get('x-ratelimit-remaining'), reset: res.headers.get('x-ratelimit-reset') },
    requestId: res.headers.get('x-request-id'),
    body: shown,
    truncated: shown.length < text.length,
  };
}

/* ---------------------------------------------------------------------- dispatch */

export async function apiManagement(deps: Deps, op: ApiManagementOp): Promise<unknown> {
  const { db, actor } = deps;
  const now = deps.now ?? Date.now();

  switch (op.op) {
    case 'overview': {
      const [integrations, day, month, recent] = await Promise.all([
        listIntegrations(db),
        db.get<Record<string, unknown>>(dayStatsPath(utcDay(now))),
        db.get<Record<string, unknown>>(monthStatsPath(utcMonth(now))),
        db.list<ApiLogRow>(LOGS, { orderBy: 'at', direction: 'DESCENDING', limit: 12 }),
      ]);
      const keys = await db.list<Record<string, unknown>>('apiKeys', { limit: 1_000 });
      const d = day?.data;
      const m = month?.data;
      const activeKeys = keys.filter((k) => k.data.status === 'active').length;
      const connected = new Set(integrations.filter((i) => i.lastUsedAt).map((i) => i.id));
      return {
        totals: {
          integrations: integrations.length,
          active: integrations.filter((i) => i.status === 'active').length,
          suspended: integrations.filter((i) => i.status === 'suspended').length,
          disabled: integrations.filter((i) => i.status === 'disabled').length,
          keys: keys.length,
          activeKeys,
          connectedApps: connected.size,
        },
        today: { requests: readNum(d, 'total.ok') + readNum(d, 'total.failed'), ok: readNum(d, 'total.ok'), failed: readNum(d, 'total.failed'), avgMs: avg(readNum(d, 'total.ms'), readNum(d, 'total.ok') + readNum(d, 'total.failed')), rateLimited: readNum(d, 'total.rateLimited') },
        month: { requests: readNum(m, 'total.requests') },
        recent: recent.map((r) => r.data),
        names: Object.fromEntries(integrations.map((i) => [i.id, i.name])),
      };
    }

    case 'list': {
      const [integrations, keys, day] = await Promise.all([listIntegrations(db), db.list<Record<string, unknown>>('apiKeys', { limit: 1_000 }), db.get<Record<string, unknown>>(dayStatsPath(utcDay(now)))]);
      return {
        integrations: integrations
          .map((i) => ({
            ...i,
            keyCount: keys.filter((k) => k.data.integrationId === i.id && k.data.status !== 'revoked').length,
            requestsToday: readNum(day?.data, `apps.${i.id}.requests`),
          }))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
      };
    }

    case 'get': {
      const integration = await mustIntegration(db, op.id);
      const [keys, month] = await Promise.all([listKeys(db, op.id), db.get<Record<string, unknown>>(monthStatsPath(utcMonth(now)))]);
      return { integration, keys: keys.map(keyView), monthRequests: readNum(month?.data, `apps.${op.id}.requests`) };
    }

    case 'create': {
      const id = newId('int');
      const stored = toStored(op.config);
      return audited(deps, { action: 'api_integration_created', integrationId: id, before: null, detail: stored.name }, async () => {
        const record = { ...stored, createdAt: now, createdBy: actor.email ?? actor.uid, updatedAt: now, updatedBy: actor.email ?? actor.uid, version: 1, lastUsedAt: null };
        await db.commit([{ op: 'set', path: integrationPath(id), data: record, precondition: { exists: false } }]);
        const integration = normalizeIntegration(id, record);
        let key: { view: ReturnType<typeof keyView>; secret: string } | null = null;
        if (op.firstKey) {
          const k = await newKeyRecord(db, id, { name: op.firstKey.name, mode: op.firstKey.mode, expiresAt: null, limits: null }, actor, now);
          key = { view: keyView(k.record), secret: k.secret };
          await audit(deps, { action: 'api_key_created', integrationId: id, keyId: k.record.id, before: null, after: keySnapshot(k.record), success: true, detail: k.record.display });
        }
        return { result: { integration, key }, after: snapshot(integration) };
      });
    }

    case 'update': {
      const before = await mustIntegration(db, op.id);
      if (before.version !== op.version) throw new HttpError(409, 'conflict', 'This integration was changed by someone else. Reload it and try again.');
      const stored = toStored(op.config);
      return audited(deps, { action: 'api_integration_updated', integrationId: op.id, before: snapshot(before), detail: stored.name }, async () => {
        const doc = await db.get(integrationPath(op.id));
        const data = { ...stored, updatedAt: now, updatedBy: actor.email ?? actor.uid, version: before.version + 1 };
        await db.commit([{ op: 'set', path: integrationPath(op.id), data, merge: true, precondition: { updateTime: doc!.updateTime! } }]);
        const after = (await loadIntegration(db, op.id))!;
        return { result: { integration: after }, after: snapshot(after) };
      });
    }

    case 'setStatus': {
      const before = await mustIntegration(db, op.id);
      return audited(deps, { action: 'api_integration_status_changed', integrationId: op.id, before: { status: before.status }, detail: `${before.status} → ${op.status}` }, async () => {
        await db.set(integrationPath(op.id), { status: op.status, updatedAt: now, updatedBy: actor.email ?? actor.uid, version: before.version + 1 }, true);
        return { result: { ok: true, status: op.status }, after: { status: op.status } };
      });
    }

    case 'delete': {
      const before = await mustIntegration(db, op.id);
      if (op.confirmName.trim() !== before.name) throw new HttpError(400, 'confirm_mismatch', 'Type the integration’s name exactly to delete it.');
      return audited(deps, { action: 'api_integration_deleted', integrationId: op.id, before: snapshot(before), detail: before.name }, async () => {
        // soft delete: every key is revoked at once and the integration can never authenticate again;
        // logs and analytics are kept for their normal retention
        const keys = await listKeys(db, op.id);
        await db.commit([
          { op: 'set', path: integrationPath(op.id), data: { status: 'deleted', deletedAt: now, updatedAt: now, updatedBy: actor.email ?? actor.uid, version: before.version + 1 }, merge: true },
          ...keys.filter((k) => k.status !== 'revoked').map((k) => ({ op: 'set' as const, path: keyPath(k.id), data: { status: 'revoked', revokedAt: now }, merge: true })),
        ]);
        return { result: { ok: true, keysRevoked: keys.filter((k) => k.status !== 'revoked').length }, after: { status: 'deleted' } };
      });
    }

    case 'keyCreate': {
      await mustIntegration(db, op.integrationId);
      return audited(deps, { action: 'api_key_created', integrationId: op.integrationId, before: null }, async () => {
        const k = await newKeyRecord(db, op.integrationId, { name: op.name, mode: op.mode, expiresAt: op.expiresAt, limits: op.limits }, actor, now);
        return { result: { key: keyView(k.record), secret: k.secret }, after: keySnapshot(k.record) };
      });
    }

    case 'keyRotate': {
      const old = await mustKey(db, op.keyId);
      await mustIntegration(db, old.integrationId);
      if (old.status === 'revoked') throw new HttpError(409, 'key_revoked', 'A revoked key cannot be rotated; create a new key instead.');
      return audited(deps, { action: 'api_key_rotated', integrationId: old.integrationId, keyId: old.id, before: keySnapshot(old), detail: `${old.display}, grace ${op.graceMinutes} min` }, async () => {
        const k = await newKeyRecord(db, old.integrationId, { name: old.name, mode: old.mode, expiresAt: old.expiresAt, limits: old.limits, rotatedFrom: old.id }, actor, now);
        // the old key stops at once, or after a grace period so the application can switch over
        const oldChange = op.graceMinutes
          ? { rotatedTo: k.record.id, expiresAt: Math.min(old.expiresAt ?? Infinity, now + op.graceMinutes * 60_000) }
          : { rotatedTo: k.record.id, status: 'revoked', revokedAt: now };
        await db.set(keyPath(old.id), oldChange, true);
        return { result: { key: keyView(k.record), secret: k.secret, previous: { id: old.id, ...oldChange } }, after: { newKey: keySnapshot(k.record), oldKey: oldChange } };
      });
    }

    case 'keyRevoke': {
      const k = await mustKey(db, op.keyId);
      return audited(deps, { action: 'api_key_revoked', integrationId: k.integrationId, keyId: k.id, before: { status: k.status }, detail: k.display }, async () => {
        await db.set(keyPath(k.id), { status: 'revoked', revokedAt: now }, true);
        return { result: { ok: true }, after: { status: 'revoked' } };
      });
    }

    case 'keySetStatus': {
      const k = await mustKey(db, op.keyId);
      if (k.status === 'revoked') throw new HttpError(409, 'key_revoked', 'A revoked key cannot be turned back on.');
      return audited(deps, { action: 'api_key_status_changed', integrationId: k.integrationId, keyId: k.id, before: { status: k.status }, detail: `${k.display}: ${op.status}` }, async () => {
        await db.set(keyPath(k.id), { status: op.status }, true);
        return { result: { ok: true, status: op.status }, after: { status: op.status } };
      });
    }

    case 'keyUpdate': {
      const k = await mustKey(db, op.keyId);
      if (k.status === 'revoked') throw new HttpError(409, 'key_revoked', 'A revoked key cannot be changed.');
      const after = { name: op.name, expiresAt: op.expiresAt, limits: normalizeKeyLimits(op.limits) };
      return audited(deps, { action: 'api_key_updated', integrationId: k.integrationId, keyId: k.id, before: { name: k.name, expiresAt: k.expiresAt, limits: k.limits }, detail: k.display }, async () => {
        await db.set(keyPath(k.id), after, true);
        return { result: { ok: true }, after };
      });
    }

    case 'activity':
      return activity(db, op.filter, now);

    case 'analytics':
      return analytics(db, op.days, op.integrationId, now);

    case 'audit': {
      const rows = await db.list<Record<string, unknown>>(AUDIT, { orderBy: 'at', direction: 'DESCENDING', limit: 300 });
      return {
        rows: rows
          .filter((r) => !op.integrationId || r.data.integrationId === op.integrationId)
          .slice(0, 150)
          .map((r) => ({ ...r.data, id: r.id })),
      };
    }

    case 'test':
      return testRequest(deps, op);
  }
}
