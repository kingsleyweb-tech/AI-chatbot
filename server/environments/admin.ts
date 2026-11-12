/**
 * Super Admin operations of the API Environment Manager (called from api/admin.ts after it checked
 * that the caller is the Super Admin). Every change is validated, health-checked, versioned and
 * written to the audit logs. Responses never contain credentials: only variable names, whether they
 * are set, health results and usage counts.
 */
import { z } from 'zod';
import { recordAdminAction, type AdminAction } from '../account/events.js';
import { usagePath as cloudflareUsagePath, utcDay as cfDay } from '../cloudflare/budget.js';
import type { Firestore } from '../firestore.js';
import { SERVER_TIME } from '../firestore.js';
import { HttpError } from '../http.js';
import {
  ENV_LABEL,
  ENV_PROVIDERS,
  ENVIRONMENTS,
  globalTarget,
  MAX_CEILING,
  normalizeEnvironmentConfig,
  overallEnvironment,
  PROVIDER_LABEL,
  SUPPORTED_ENVIRONMENTS,
  supports,
  type CredentialView,
  type EnvId,
  type EnvironmentConfig,
  type EnvironmentUsageRow,
  type EnvProvider,
  type HealthResult,
} from '../shared/environments.js';
import { checkHealth, storedHealth } from './health.js';
import {
  credentialsConfigured,
  credentialVariables,
  ENV_CONFIG_PATH,
  envUsagePath,
  isoWeek,
  setEnvironmentCache,
  sharedCredentials,
  utcDay,
  utcMonth,
} from './index.js';

const provider = z.enum(ENV_PROVIDERS);
const environment = z.enum(ENVIRONMENTS);
const reason = z.string().max(300).optional();

export const environmentOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('health'), provider: provider.optional(), environment: environment.optional() }),
  z.object({ op: z.literal('switch'), scope: z.enum(['global', 'provider']), provider: provider.optional(), environment, confirm: z.literal(true), reason }),
  z.object({ op: z.literal('disable'), provider, environment, disabled: z.boolean(), confirm: z.literal(true), reason }),
  z.object({
    op: z.literal('ceiling'),
    daily: z.number().int().min(0).max(MAX_CEILING),
    weekly: z.number().int().min(0).max(MAX_CEILING),
    reason,
  }),
]);
export type EnvironmentOp = z.infer<typeof environmentOpSchema>;

export interface EnvironmentAdminDeps {
  db: Firestore;
  actor: { uid: string; email: string | null };
  now?: number;
  /** for tests: replaces the live provider checks */
  check?: (p: EnvProvider, e: EnvId) => Promise<HealthResult>;
}

const AUDIT = 'envAudit';
const pairs = (): [EnvProvider, EnvId][] => ENV_PROVIDERS.flatMap((p) => SUPPORTED_ENVIRONMENTS[p].map((e) => [p, e] as [EnvProvider, EnvId]));
const describe = (cfg: Pick<EnvironmentConfig, 'providers'>) => ENV_PROVIDERS.map((p) => `${PROVIDER_LABEL[p]}: ${ENV_LABEL[cfg.providers[p]]}`).join(', ');

async function readConfig(db: Firestore) {
  const doc = await db.get<Record<string, unknown>>(ENV_CONFIG_PATH);
  return { config: normalizeEnvironmentConfig(doc?.data), updateTime: doc?.updateTime ?? null };
}

/** Save with optimistic concurrency: two administrators can never overwrite each other's change unseen. */
async function saveConfig(db: Firestore, next: EnvironmentConfig, updateTime: string | null) {
  try {
    await db.commit([
      {
        op: 'set',
        path: ENV_CONFIG_PATH,
        data: { ...next, updatedAt: new Date(next.updatedAt ?? Date.now()), savedAt: SERVER_TIME },
        precondition: updateTime ? { updateTime } : { exists: false },
      },
    ]);
  } catch {
    throw new HttpError(409, 'conflict', 'The API environment settings changed while you were editing. Reload and try again.');
  }
  setEnvironmentCache(next); // this instance at once; the others within 15 seconds
}

async function audit(
  d: EnvironmentAdminDeps,
  action: AdminAction,
  detail: string,
  changes: { before: unknown; after: unknown },
  extra: { providers: EnvProvider[]; result: 'success' | 'refused'; previous?: string; next?: string },
) {
  const now = d.now ?? Date.now();
  await recordAdminAction(d.db, {
    action,
    adminUid: d.actor.uid,
    adminEmail: d.actor.email,
    targetUid: ENV_CONFIG_PATH,
    targetEmail: null,
    detail,
    changes,
  });
  await d.db
    .set(`${AUDIT}/${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, {
      action,
      adminUid: d.actor.uid,
      adminEmail: d.actor.email,
      detail: detail.slice(0, 300),
      providers: extra.providers,
      result: extra.result,
      previous: extra.previous ?? null,
      next: extra.next ?? null,
      at: new Date(now),
    })
    .catch(() => undefined);
}

/* ------------------------------------- status ------------------------------------- */

function counter(data: Record<string, unknown> | undefined, ...path: string[]): number {
  let v: unknown = data;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  if (v === undefined && data) v = data[path.join('.')];
  return Number(v ?? 0) || 0;
}

async function usageRows(db: Firestore, now: number) {
  const keys = { d: utcDay(now), w: isoWeek(now), m: utcMonth(now) } as const;
  const docs = await Promise.all(
    ENVIRONMENTS.flatMap((e) => (['d', 'w', 'm'] as const).map((k) => db.get<Record<string, unknown>>(envUsagePath(e, k, keys[k])).then((x) => x?.data).catch(() => undefined))),
  );
  const at = (e: EnvId, k: 'd' | 'w' | 'm') => docs[ENVIRONMENTS.indexOf(e) * 3 + ['d', 'w', 'm'].indexOf(k)];
  const rows: EnvironmentUsageRow[] = [];
  for (const e of ENVIRONMENTS)
    for (const p of ENV_PROVIDERS)
      if (supports(p, e))
        rows.push({
          environment: e,
          provider: p,
          today: counter(at(e, 'd'), p, 'requests'),
          week: counter(at(e, 'w'), p, 'requests'),
          month: counter(at(e, 'm'), p, 'requests'),
        });
  const temporary = {
    today: counter(at('temporary', 'd'), 'total'),
    week: counter(at('temporary', 'w'), 'total'),
    refusedToday: counter(at('temporary', 'd'), 'refused'),
    refusedWeek: counter(at('temporary', 'w'), 'refused'),
    day: keys.d,
    isoWeek: keys.w,
  };
  // provider-confirmed: Cloudflare's own Neuron figure per account (cf-ai-neurons), today (UTC)
  const cf = await db.get<Record<string, unknown>>(cloudflareUsagePath(cfDay(now))).then((x) => x?.data).catch(() => undefined);
  const cfNeurons = (ids: string[]) =>
    ids.reduce((n, id) => n + (id === 'A' ? Math.max(0, counter(cf, 'neurons') - counter(cf, 'accounts', 'B', 'neurons') - counter(cf, 'accounts', 'T', 'neurons')) : counter(cf, 'accounts', id, 'neurons')), 0);
  const cloudflareNeuronsToday: Record<EnvId, number> = { main: +cfNeurons(['A', 'B']).toFixed(1), secondary: +cfNeurons(['B']).toFixed(1), temporary: +cfNeurons(['T']).toFixed(1) };
  return { rows, temporary, cloudflareNeuronsToday };
}

export async function environmentStatus(d: EnvironmentAdminDeps) {
  const now = d.now ?? Date.now();
  const [{ config }, health, usage, history] = await Promise.all([
    readConfig(d.db),
    storedHealth(pairs()),
    usageRows(d.db, now),
    d.db.list<Record<string, unknown>>(AUDIT, { orderBy: 'at', direction: 'DESCENDING', limit: 50 }).catch(() => []),
  ]);
  const credentials: CredentialView[] = pairs().map(([p, e]) => ({
    provider: p,
    environment: e,
    variables: credentialVariables(p, e).map(({ name, set }) => ({ name, set })),
    configured: credentialsConfigured(p, e),
    sharedWith: sharedCredentials(p, e, SUPPORTED_ENVIRONMENTS[p]),
    disabled: config.disabled[p].includes(e),
    health: health.get(`${p}_${e}`) ?? null,
  }));
  return {
    config,
    overall: overallEnvironment(config),
    credentials,
    usage,
    history: history.map((h) => ({ id: h.id, ...h.data })),
    elevenLabs: 'shared',
    generatedAt: now,
  };
}

/* ---------------------------------- operations ---------------------------------- */

export async function environmentAdmin(d: EnvironmentAdminDeps, b: EnvironmentOp): Promise<unknown> {
  const now = d.now ?? Date.now();
  const check = d.check ?? ((p: EnvProvider, e: EnvId) => checkHealth(p, e, now));
  const by = d.actor.email ?? d.actor.uid;

  if (b.op === 'status') return environmentStatus(d);

  if (b.op === 'health') {
    const list = pairs().filter(([p, e]) => (!b.provider || p === b.provider) && (!b.environment || e === b.environment));
    if (!list.length) throw new HttpError(400, 'unsupported', 'That provider has no such environment.');
    const results = await Promise.all(list.map(async ([p, e]) => ({ provider: p, environment: e, ...(await check(p, e)) })));
    return { results };
  }

  if (b.op === 'switch') {
    const { config: before, updateTime } = await readConfig(d.db);
    let target: Record<EnvProvider, EnvId>;
    let affected: EnvProvider[];
    if (b.scope === 'provider') {
      if (!b.provider) throw new HttpError(400, 'bad_request', 'Choose a provider.');
      if (!supports(b.provider, b.environment))
        throw new HttpError(400, 'unsupported', `${PROVIDER_LABEL[b.provider]} has no ${ENV_LABEL[b.environment]} credentials. It can use: ${SUPPORTED_ENVIRONMENTS[b.provider].map((e) => ENV_LABEL[e]).join(', ')}.`);
      target = { ...before.providers, [b.provider]: b.environment };
      affected = [b.provider];
    } else {
      target = Object.fromEntries(ENV_PROVIDERS.map((p) => [p, globalTarget(p, b.environment)])) as Record<EnvProvider, EnvId>;
      affected = [...ENV_PROVIDERS];
    }
    // every provider that will run on the target set is validated now, before anything changes
    const problems: string[] = [];
    const results: ({ provider: EnvProvider; environment: EnvId } & HealthResult)[] = [];
    await Promise.all(
      affected.map(async (p) => {
        const e = target[p];
        if (before.disabled[p].includes(e)) {
          problems.push(`${PROVIDER_LABEL[p]} (${ENV_LABEL[e]}) is switched off.`);
          return;
        }
        if (!credentialsConfigured(p, e)) {
          problems.push(`${PROVIDER_LABEL[p]} (${ENV_LABEL[e]}): credentials are missing (${credentialVariables(p, e).filter((v) => !v.set && !v.optional).map((v) => v.name).join(', ')}).`);
          return;
        }
        const r = await check(p, e);
        results.push({ provider: p, environment: e, ...r });
        if (!r.ok) problems.push(`${PROVIDER_LABEL[p]} (${ENV_LABEL[e]}): ${r.detail}`);
      }),
    );
    const after: EnvironmentConfig = {
      ...before,
      providers: target,
      global: b.scope === 'global' ? b.environment : before.global,
      version: before.version + 1,
      updatedAt: now,
      updatedBy: by,
    };
    const what = b.scope === 'global' ? `everything to ${ENV_LABEL[b.environment]}` : `${PROVIDER_LABEL[b.provider!]} to ${ENV_LABEL[b.environment]}`;
    if (problems.length) {
      await audit(d, 'environment_switch_refused', `Switch ${what} refused: ${problems.join(' ')}${b.reason ? ` Reason: ${b.reason}` : ''}`, { before: before.providers, after: target }, {
        providers: affected,
        result: 'refused',
        previous: describe(before),
        next: describe({ providers: target }),
      });
      throw new HttpError(409, 'switch_refused', `Not switched: ${problems.join(' ')}`, { problems, results });
    }
    await saveConfig(d.db, after, updateTime);
    await audit(
      d,
      'environment_switched',
      `Switched ${what} (version ${after.version}). ${describe(after)}.${b.reason ? ` Reason: ${b.reason}` : ''}`,
      { before: { global: before.global, providers: before.providers }, after: { global: after.global, providers: after.providers } },
      { providers: affected, result: 'success', previous: describe(before), next: describe(after) },
    );
    return { config: after, results };
  }

  if (b.op === 'disable') {
    if (!supports(b.provider, b.environment)) throw new HttpError(400, 'unsupported', `${PROVIDER_LABEL[b.provider]} has no ${ENV_LABEL[b.environment]} credentials.`);
    const { config: before, updateTime } = await readConfig(d.db);
    const list = before.disabled[b.provider].filter((e) => e !== b.environment);
    const after: EnvironmentConfig = {
      ...before,
      disabled: { ...before.disabled, [b.provider]: b.disabled ? [...list, b.environment] : list },
      version: before.version + 1,
      updatedAt: now,
      updatedBy: by,
    };
    await saveConfig(d.db, after, updateTime);
    const active = before.providers[b.provider] === b.environment;
    await audit(
      d,
      b.disabled ? 'environment_disabled' : 'environment_enabled',
      `${PROVIDER_LABEL[b.provider]} ${ENV_LABEL[b.environment]} ${b.disabled ? 'switched off' : 'switched back on'}${b.disabled && active ? ' (it was in use: the provider is unavailable until it is switched back on or moved to another environment)' : ''}.${b.reason ? ` Reason: ${b.reason}` : ''}`,
      { before: before.disabled[b.provider], after: after.disabled[b.provider] },
      { providers: [b.provider], result: 'success' },
    );
    return { config: after };
  }

  // ceiling
  const { config: before, updateTime } = await readConfig(d.db);
  if (b.weekly < b.daily) throw new HttpError(400, 'bad_ceiling', 'The weekly ceiling cannot be lower than the daily ceiling.');
  const after: EnvironmentConfig = { ...before, temporaryCeiling: { daily: b.daily, weekly: b.weekly }, version: before.version + 1, updatedAt: now, updatedBy: by };
  await saveConfig(d.db, after, updateTime);
  await audit(
    d,
    'environment_ceiling_changed',
    `Temporary ceiling: ${before.temporaryCeiling.daily}/day, ${before.temporaryCeiling.weekly}/week -> ${b.daily}/day, ${b.weekly}/week.${b.reason ? ` Reason: ${b.reason}` : ''}`,
    { before: before.temporaryCeiling, after: after.temporaryCeiling },
    { providers: [], result: 'success' },
  );
  return { config: after };
}
