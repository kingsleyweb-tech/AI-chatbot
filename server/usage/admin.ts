/**
 * Administrator operations on AI allowances (called from api/admin.ts, which has already
 * checked that the caller is an administrator). Every change is written to adminLogs with
 * the previous and new values.
 */
import { z } from 'zod';
import { recordAdminAction, type AdminAction } from '../account/events.js';
import type { Firestore } from '../firestore.js';
import { SERVER_TIME } from '../firestore.js';
import { HttpError } from '../http.js';
import { env } from '../env.js';
import { usageEnv } from '../environments/index.js';
import { ENV_LABEL } from '../shared/environments.js';
import { elevenLabsConfigured } from '../elevenlabs/client.js';
import {
  accountPath,
  clearUsageCache,
  loadUsageConfig,
  resetAllowance,
  snapshotOf,
  updateAccount,
  usageHistory,
  usageConfigPath,
  accountsCollection,
  usageStatsCollection,
} from './allowance.js';
import {
  BUILTIN_PROFILES,
  FEATURE_INFO,
  FEATURES,
  formatReset,
  grantActive,
  MAX_LIMIT,
  normalizeLimits,
  normalizePartialLimits,
  normalizeUsageConfig,
  PROFILE_ID,
  validTimeZone,
  type FeatureId,
  type UsageAccount,
  type UsageConfig,
} from './policy.js';

const feature = z.enum(FEATURES);
const limitValue = z.number().int().min(0).max(MAX_LIMIT).nullable();
const periodLimit = z.object({ daily: limitValue, weekly: limitValue });
const partialPeriod = z.object({ daily: limitValue.optional(), weekly: limitValue.optional() });
const fullLimits = z.object(Object.fromEntries(FEATURES.map((f) => [f, periodLimit])) as Record<FeatureId, typeof periodLimit>);
const partialLimits = z.object(Object.fromEntries(FEATURES.map((f) => [f, partialPeriod.optional()])) as Record<FeatureId, z.ZodOptional<typeof partialPeriod>>);
const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const reason = z.string().max(300).optional();

export const usageOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get') }),
  z.object({
    op: z.literal('config'),
    enabled: z.boolean().optional(),
    features: z.object(Object.fromEntries(FEATURES.map((f) => [f, z.object({ enabled: z.boolean() }).optional()]))).optional(),
    reset: z.object({ timezone: z.string().max(64), dailyTime: time, weeklyDay: z.number().int().min(0).max(6), weeklyTime: time }).optional(),
    defaultProfile: z.string().max(32).optional(),
  }),
  z.object({
    op: z.literal('profileSave'),
    id: z.string().regex(PROFILE_ID),
    name: z.string().min(1).max(40),
    description: z.string().max(200).default(''),
    limits: fullLimits,
  }),
  z.object({ op: z.literal('profileDelete'), id: z.string().regex(PROFILE_ID), confirm: z.literal(true) }),
  z.object({ op: z.literal('users') }),
  z.object({ op: z.literal('user'), uid }),
  z.object({
    op: z.literal('assign'),
    uid,
    profile: z.string().max(32).optional(),
    /** null clears the custom limits */
    customLimits: partialLimits.nullable().optional(),
    /** a temporary override; null removes it */
    override: z.object({ limits: partialLimits, until: z.number().int().positive().nullable() }).nullable().optional(),
    reason,
  }),
  z.object({
    op: z.literal('unlimited'),
    uid,
    grant: z.boolean(),
    /** when the grant ends (ms); null = permanent. A duration is sent as its end time. */
    until: z.number().int().positive().nullable().optional(),
    reason,
    confirm: z.literal(true),
  }),
  z.object({
    op: z.literal('reset'),
    uid,
    feature: z.union([feature, z.literal('all')]),
    period: z.enum(['daily', 'weekly', 'both']),
    reason,
    confirm: z.literal(true),
  }),
  z.object({ op: z.literal('analytics'), days: z.number().int().min(1).max(60).optional() }),
  z.object({ op: z.literal('health') }),
]);

/**
 * System health for administrators: which services are configured (yes/no only, never a key
 * or an id), the database round trip, and the deployment. Read-only.
 */
export async function systemHealth(db: Firestore) {
  const e = env();
  const started = Date.now();
  let database: { ok: boolean; ms: number | null };
  try {
    await db.get('config/usage');
    database = { ok: true, ms: Date.now() - started };
  } catch {
    database = { ok: false, ms: null };
  }
  return {
    database,
    services: {
      serverIdentity: Boolean(e.serviceAccount),
      superAdminConfigured: e.adminEmails.length > 0,
      geminiAccounts: [e.geminiKey, e.geminiKeySecondary].filter(Boolean).length,
      cloudflareAccounts: [e.cloudflareAccountId && e.cloudflareApiToken, e.cloudflareAccountIdSecondary && e.cloudflareApiTokenSecondary].filter(Boolean).length,
      openrouter: Boolean(e.openRouterKey),
      tavily: Boolean(e.tavilyKey),
      serpapi: Boolean(e.serpApiKey),
      elevenlabs: elevenLabsConfigured(),
      email: e.emailProvider === 'brevo' && Boolean(e.brevoKey && e.emailFrom),
      sms: Boolean(e.vynfyKey),
    },
    deployment: {
      region: process.env.VERCEL_REGION ?? null,
      environment: process.env.VERCEL_ENV ?? 'local',
      commit: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
    },
    checkedAt: Date.now(),
  };
}
export type UsageOp = z.infer<typeof usageOpSchema>;

export interface UsageAdminDeps {
  db: Firestore;
  actor: { uid: string; email: string | null };
  /** uid -> email and name of every account (from Firebase Auth) */
  accounts: () => Promise<{ uid: string; email: string | null; name: string }[]>;
  /** administrators are unlimited automatically */
  isAdminEmail: (email: string | null) => boolean;
  now?: number;
}

async function log(d: UsageAdminDeps, action: AdminAction, target: { uid: string; email: string | null }, detail: string, changes: { before: unknown; after: unknown }) {
  // changes to another API environment's allowances say which environment they apply to
  const e = usageEnv();
  const where = e === 'main' ? '' : `[${ENV_LABEL[e]} environment] `;
  await recordAdminAction(d.db, { action, adminUid: d.actor.uid, adminEmail: d.actor.email, targetUid: target.uid, targetEmail: target.email, detail: where + detail, changes });
}

async function saveConfig(db: Firestore, cfg: UsageConfig) {
  // built-in profiles keep their names: only their limits and descriptions are stored
  const profiles: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(cfg.profiles)) {
    profiles[id] = id in BUILTIN_PROFILES ? { limits: p.limits, description: p.description } : { name: p.name, description: p.description, limits: p.limits };
  }
  await db.set(usageConfigPath(), { enabled: cfg.enabled, features: cfg.features, reset: cfg.reset, defaultProfile: cfg.defaultProfile, profiles, updatedAt: SERVER_TIME });
  clearUsageCache();
}

const describeLimits = (l: Partial<Record<FeatureId, { daily?: number | null; weekly?: number | null }>> | null | undefined) =>
  !l || !Object.keys(l).length
    ? 'none'
    : Object.entries(l)
        .map(([f, v]) => `${FEATURE_INFO[f as FeatureId].label} ${v?.daily ?? '∞'}/day ${v?.weekly ?? '∞'}/week`)
        .join(', ');

export async function usageAdmin(d: UsageAdminDeps, b: UsageOp): Promise<unknown> {
  const { db } = d;
  const now = d.now ?? Date.now();
  const target = async (u: string) => ({ uid: u, email: (await d.accounts()).find((a) => a.uid === u)?.email ?? null });

  if (b.op === 'get') {
    const cfg = await loadUsageConfig(db, true);
    return { config: cfg, features: FEATURES.map((f) => ({ id: f, ...FEATURE_INFO[f] })), builtin: Object.keys(BUILTIN_PROFILES) };
  }

  if (b.op === 'config') {
    const before = await loadUsageConfig(db, true);
    if (b.reset && !validTimeZone(b.reset.timezone)) throw new HttpError(400, 'bad_timezone', 'That time zone is not recognised.');
    if (b.defaultProfile && (!before.profiles[b.defaultProfile] || before.profiles[b.defaultProfile].unlimited))
      throw new HttpError(400, 'bad_profile', 'Choose a limited profile as the default.');
    const after = normalizeUsageConfig({
      ...before,
      ...(b.enabled === undefined ? {} : { enabled: b.enabled }),
      features: { ...before.features, ...(b.features ?? {}) },
      reset: b.reset ?? before.reset,
      defaultProfile: b.defaultProfile ?? before.defaultProfile,
    });
    await saveConfig(db, after);
    const pick = (c: UsageConfig) => ({ enabled: c.enabled, features: c.features, reset: c.reset, defaultProfile: c.defaultProfile });
    await log(d, 'usage_config_changed', { uid: usageConfigPath(), email: null }, `Limits ${after.enabled ? 'on' : 'off'}; resets ${after.reset.dailyTime} daily, day ${after.reset.weeklyDay} ${after.reset.weeklyTime} weekly (${after.reset.timezone})`, {
      before: pick(before),
      after: pick(after),
    });
    return { config: after };
  }

  if (b.op === 'profileSave') {
    const before = await loadUsageConfig(db, true);
    if (b.id === 'unlimited') throw new HttpError(400, 'bad_profile', 'The Unlimited AI Access profile has no limits to change.');
    const prev = before.profiles[b.id] ?? null;
    const isBuiltin = b.id in BUILTIN_PROFILES;
    const after: UsageConfig = {
      ...before,
      profiles: { ...before.profiles, [b.id]: { ...(prev ?? {}), name: isBuiltin ? prev!.name : b.name, description: b.description, limits: normalizeLimits(b.limits), ...(isBuiltin ? { builtin: true } : {}) } },
    };
    await saveConfig(db, after);
    await log(d, 'usage_profile_saved', { uid: `${usageConfigPath()}#${b.id}`, email: null }, `Profile ${after.profiles[b.id].name}: ${describeLimits(after.profiles[b.id].limits)}`, {
      before: prev ? { name: prev.name, limits: prev.limits } : null,
      after: { name: after.profiles[b.id].name, limits: after.profiles[b.id].limits },
    });
    return { config: after };
  }

  if (b.op === 'profileDelete') {
    if (b.id in BUILTIN_PROFILES) throw new HttpError(400, 'builtin_profile', 'Built-in profiles cannot be deleted.');
    const before = await loadUsageConfig(db, true);
    const prev = before.profiles[b.id];
    if (!prev) throw new HttpError(404, 'not_found', 'No such profile.');
    if (before.defaultProfile === b.id) throw new HttpError(400, 'default_profile', 'Choose another default profile first.');
    const profiles = { ...before.profiles };
    delete profiles[b.id];
    await saveConfig(db, { ...before, profiles });
    // accounts on the deleted profile fall back to the default profile (their other settings stay)
    await log(d, 'usage_profile_deleted', { uid: `${usageConfigPath()}#${b.id}`, email: null }, `Profile ${prev.name} deleted; its accounts use ${before.profiles[before.defaultProfile].name}`, {
      before: { name: prev.name, limits: prev.limits },
      after: null,
    });
    return { ok: true };
  }

  if (b.op === 'users') {
    const [cfg, accounts, rows] = await Promise.all([loadUsageConfig(db, true), d.accounts(), db.list<UsageAccount>(accountsCollection(), { limit: 2500 })]);
    const byUid = new Map(rows.map((r) => [r.id, r.data]));
    const users = accounts.map((a) => {
      const acct = byUid.get(a.uid) ?? null;
      const snap = snapshotOf(cfg, acct, d.isAdminEmail(a.email), now);
      const limited = snap.features.filter((f) => f.percent !== null);
      return {
        uid: a.uid,
        email: a.email,
        name: a.name,
        profile: snap.profile,
        unlimited: snap.unlimited,
        unlimitedUntil: snap.unlimitedUntil,
        hasCustom: Boolean(acct?.customLimits && Object.keys(acct.customLimits).length),
        override: acct?.override && (acct.override.until === null || acct.override.until > now) ? { until: acct.override.until } : null,
        maxPercent: limited.length ? Math.max(...limited.map((f) => f.percent!)) : null,
        exhausted: snap.features.filter((f) => f.exhausted).map((f) => f.id),
        near: limited.filter((f) => !f.exhausted && f.percent! >= 75).map((f) => f.id),
        used: Object.fromEntries(snap.features.map((f) => [f.id, f.daily.used])),
      };
    });
    users.sort((x, y) => (y.maxPercent ?? -1) - (x.maxPercent ?? -1));
    return { users, generatedAt: now, timezone: cfg.reset.timezone };
  }

  if (b.op === 'user') {
    const [cfg, doc, history, t] = await Promise.all([loadUsageConfig(db, true), db.get<UsageAccount>(accountPath(b.uid)), usageHistory(db, b.uid, 30), target(b.uid)]);
    const acct = doc?.data ?? null;
    return {
      uid: b.uid,
      email: t.email,
      account: { profile: acct?.profile ?? null, customLimits: acct?.customLimits ?? null, override: acct?.override ?? null, unlimited: acct?.unlimited ?? null },
      snapshot: snapshotOf(cfg, acct, d.isAdminEmail(t.email), now),
      history,
    };
  }

  if (b.op === 'assign') {
    const cfg = await loadUsageConfig(db, true);
    if (b.profile !== undefined && !cfg.profiles[b.profile]) throw new HttpError(400, 'bad_profile', 'No such profile.');
    if (b.override?.until && b.override.until <= now) throw new HttpError(400, 'bad_time', 'The override must end in the future.');
    const t = await target(b.uid);
    const { before, after } = await updateAccount(db, b.uid, () => ({
      // only the fields that were sent change: a new profile keeps custom limits, grants and every other permission
      ...(b.profile !== undefined ? { profile: b.profile } : {}),
      ...(b.customLimits !== undefined ? { customLimits: b.customLimits ? normalizePartialLimits(b.customLimits) : null } : {}),
      ...(b.override !== undefined ? { override: b.override ? { limits: normalizePartialLimits(b.override.limits), until: b.override.until, reason: b.reason ?? null } : null } : {}),
    }));
    const pick = (a: UsageAccount) => ({ profile: a.profile ?? cfg.defaultProfile, customLimits: a.customLimits ?? null, override: a.override ?? null });
    const parts = [
      b.profile !== undefined ? `profile ${cfg.profiles[before.profile ?? cfg.defaultProfile]?.name ?? before.profile} → ${cfg.profiles[b.profile].name}` : null,
      b.customLimits !== undefined ? `custom limits: ${describeLimits(after.customLimits)}` : null,
      b.override !== undefined ? (b.override ? `override ${describeLimits(after.override?.limits)} until ${b.override.until ? formatReset(b.override.until, cfg.reset.timezone).slice(3) : 'removed manually'}` : 'override removed') : null,
      b.reason ? `reason: ${b.reason}` : null,
    ].filter(Boolean);
    await log(d, 'usage_profile_assigned', t, parts.join('; ') || 'no change', { before: pick(before), after: pick(after) });
    return { ok: true };
  }

  if (b.op === 'unlimited') {
    const cfg = await loadUsageConfig(db, true);
    const t = await target(b.uid);
    if (b.grant) {
      const until = b.until ?? null;
      if (until !== null && until <= now) throw new HttpError(400, 'bad_time', 'The end time must be in the future.');
      const { before } = await updateAccount(db, b.uid, (a) => ({
        unlimited: { until, previousProfile: a.profile ?? cfg.defaultProfile, grantedBy: d.actor.uid, grantedAt: now, reason: b.reason ?? null },
      }));
      await log(
        d,
        'usage_unlimited_granted',
        t,
        `Unlimited AI access ${until === null ? 'permanently' : `until ${formatReset(until, cfg.reset.timezone).slice(3)}`}${b.reason ? `; reason: ${b.reason}` : ''}`,
        { before: { unlimited: grantActive(before.unlimited, now), until: before.unlimited?.until ?? null, profile: before.profile ?? cfg.defaultProfile }, after: { unlimited: true, until, profile: before.profile ?? cfg.defaultProfile } },
      );
    } else {
      const { before } = await updateAccount(db, b.uid, (a) => {
        if (!a.unlimited) throw new HttpError(400, 'not_unlimited', 'This account does not have unlimited access.');
        return { unlimited: null };
      });
      await log(d, 'usage_unlimited_revoked', t, `Unlimited AI access removed; profile ${cfg.profiles[before.profile ?? cfg.defaultProfile]?.name ?? 'default'} applies${b.reason ? `; reason: ${b.reason}` : ''}`, {
        before: { unlimited: true, until: before.unlimited?.until ?? null },
        after: { unlimited: false, profile: before.profile ?? cfg.defaultProfile },
      });
    }
    return { ok: true };
  }

  if (b.op === 'reset') {
    const t = await target(b.uid);
    const { before, after } = await resetAllowance(db, b.uid, b.feature, b.period, now);
    const which = b.feature === 'all' ? 'all features' : FEATURE_INFO[b.feature].label;
    await log(d, 'usage_reset', t, `Allowance reset: ${which}, ${b.period === 'both' ? 'daily and weekly' : b.period}${b.reason ? `; reason: ${b.reason}` : ''}`, { before, after });
    return { ok: true };
  }

  if (b.op === 'health') return systemHealth(db);

  // analytics: totals per day across all users
  const days = b.days ?? 14;
  const rows = await db.list<Record<string, unknown>>(usageStatsCollection(), { orderBy: 'day', direction: 'DESCENDING', limit: days });
  return {
    days: rows.map((r) => {
      const out: Record<string, unknown> = { day: r.data.day ?? r.id };
      for (const f of FEATURES) {
        out[f] = { requests: Number(r.data[`${f}_requests`] ?? 0), units: Number(r.data[`${f}_units`] ?? 0), released: Number(r.data[`${f}_released`] ?? 0) };
      }
      return out;
    }),
  };
}
