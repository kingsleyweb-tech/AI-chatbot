import { createHash, randomUUID } from 'node:crypto';
import { trustedDb } from '../admin.js';
import { utcDay } from '../cloudflare/budget.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { DEFAULT_CONFIG, PERMISSIONS, type Actor, type CentralConfig, type Permission } from './types.js';

export const RECORDS = 'kcRecords';
export const CATEGORIES = 'kcCategories';
export const AUDIT = 'kcAudit';
export const STATS = 'kcStats';
export const TOPICS = 'kcTopics';
export const DISCOVERY = 'kcDiscovery';
export const CONFIG = 'config/knowledge';

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 20);
export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** Every central-knowledge read and write uses the server identity. */
export const centralDb = (userDb: Firestore) => trustedDb(userDb);

/* ------------------------------ settings ------------------------------ */

function int(v: unknown, d: number, min: number, max: number) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
}

export function normalizeConfig(raw: unknown): CentralConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const admins: Record<string, Permission[]> = {};
  for (const [email, perms] of Object.entries((r.admins as Record<string, unknown>) ?? {}).slice(0, 50)) {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]{1,255}$/.test(e) || !Array.isArray(perms)) continue;
    const p = PERMISSIONS.filter((x) => perms.includes(x));
    if (p.length) admins[e] = p.includes('view') ? p : ['view', ...p];
  }
  const categoryReviewDays: Record<string, number> = {};
  for (const [k, v] of Object.entries((r.categoryReviewDays as Record<string, unknown>) ?? {}).slice(0, 200)) if (/^[A-Za-z0-9_-]{1,40}$/.test(k)) categoryReviewDays[k] = int(v, 180, 7, 3650);
  return {
    admins,
    reviewDays: int(r.reviewDays, DEFAULT_CONFIG.reviewDays, 7, 3650),
    categoryReviewDays,
    retrievalEnabled: typeof r.retrievalEnabled === 'boolean' ? r.retrievalEnabled : DEFAULT_CONFIG.retrievalEnabled,
    discoveryFromWebSearch: r.discoveryFromWebSearch === true,
    discoveryDailyCap: int(r.discoveryDailyCap, DEFAULT_CONFIG.discoveryDailyCap, 0, 100),
    topicInsights: r.topicInsights === true,
    assessmentsDailyCap: int(r.assessmentsDailyCap, DEFAULT_CONFIG.assessmentsDailyCap, 0, 2000),
  };
}

let configCache: { at: number; value: CentralConfig } | null = null;
export function resetCentralConfigCache() {
  configCache = null;
}

export async function loadConfig(db: Firestore, fresh = false): Promise<CentralConfig> {
  if (!fresh && configCache && Date.now() - configCache.at < 60_000) return configCache.value;
  let raw: unknown = null;
  try {
    raw = (await db.get(CONFIG))?.data ?? null;
  } catch {
    // unreadable: defaults (retrieval on, every opt-in off)
  }
  const value = normalizeConfig(raw);
  configCache = { at: Date.now(), value };
  return value;
}

export async function saveConfig(db: Firestore, config: CentralConfig, by: Actor): Promise<CentralConfig> {
  const value = normalizeConfig(config);
  await db.set(CONFIG, { ...value, updatedAt: Date.now(), updatedBy: by.uid });
  configCache = { at: Date.now(), value };
  return value;
}

/* ------------------------------ roles ------------------------------ */

export type Role = { kind: 'super' } | { kind: 'knowledge_admin'; permissions: Permission[] } | { kind: 'none' };

/**
 * Super Admin: the platform's administrators (bootstrap owners and config/access admins).
 * Knowledge Administrators: emails listed in config/knowledge with chosen permissions.
 * Everyone else: no access to any management action.
 */
export function roleFor(user: { email: string | null; emailVerified?: boolean }, platformAdmin: boolean, config: CentralConfig): Role {
  if (platformAdmin) return { kind: 'super' };
  const email = user.email?.toLowerCase();
  if (email && user.emailVerified !== false && config.admins[email]?.length) return { kind: 'knowledge_admin', permissions: config.admins[email] };
  return { kind: 'none' };
}

export function can(role: Role, p: Permission | 'settings' | 'roles'): boolean {
  if (role.kind === 'super') return true;
  if (role.kind === 'none') return false;
  return p !== 'settings' && p !== 'roles' && role.permissions.includes(p);
}

export function requirePermission(role: Role, p: Permission | 'settings' | 'roles') {
  if (!can(role, p)) throw new HttpError(403, 'forbidden', role.kind === 'none' ? 'Knowledge management is limited to administrators.' : 'Your knowledge administrator role does not include this action.');
}

/* ------------------------------ audit + counters ------------------------------ */

export async function audit(db: Firestore, a: { actor: Actor; action: string; recordId?: string | null; detail?: string }) {
  const at = Date.now();
  await db.set(`${AUDIT}/${at.toString(36)}${newId().slice(0, 6)}`, {
    at,
    actorUid: a.actor.uid,
    actorEmail: a.actor.email,
    action: a.action,
    recordId: a.recordId ?? null,
    // short and content-free
    detail: (a.detail ?? '').slice(0, 300),
  });
}

export async function bump(db: Firestore, counts: Record<string, number>, now = Date.now()) {
  const day = utcDay(now);
  await db.commit([{ op: 'increment', path: `${STATS}/${day}`, increments: counts, data: { day } }]);
}

export async function todayCount(db: Firestore, key: string, now = Date.now()): Promise<number> {
  const d = await db.get<Record<string, number>>(`${STATS}/${utcDay(now)}`).catch(() => null);
  return d?.data[key] ?? 0;
}
