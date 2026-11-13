/**
 * Where the API platform keeps its records. Every collection here is server-only: the Firestore
 * rules' default deny (`match /{document=**}`, server identity only) covers them, so no browser,
 * not even an administrator's, can read or write them directly.
 *
 *  apiIntegrations/{id}   one connected application (permissions, limits, environments)
 *  apiKeys/{keyId}        one key: SHA-256 hash only, never the key itself
 *  apiEndUsers/{euid}     the end users an application has used (for isolation and deletion)
 *  apiAudit/{id}          administrator changes with the previous and new configuration
 *  apiLogs/{id}           request log (no prompts, documents, keys or tokens)
 *  apiStats/{d-|w-|m-}…   usage counters per day, ISO week and month (limits and analytics)
 *  apiRate/{…}            per-minute and per-hour counters (only when such a limit is set)
 *  apiConc/{…}            concurrent-request counters (2-minute buckets, self-healing)
 *  apiIdem/{…}            idempotency records (24 hours)
 *
 * End users of an application get their own Atlas AI data space users/{euid}, where
 * euid = "apiu_" + sha256(integration id + ":" + the application's user id). The integration id
 * comes from the authenticated key, never from the request, so one application can never address
 * another application's users, conversations, documents, memories or images.
 */
import { normalizeIntegration, type ApiKeyView, type IntegrationConfig, type KeyLimits, type KeyMode, type KeyStatus } from '../shared/apiPlatform.js';
import { normalizeKeyLimits } from '../shared/apiPlatform.js';
import type { Firestore } from '../firestore.js';
import { shortHash } from './keys.js';

export const INTEGRATIONS = 'apiIntegrations';
export const KEYS = 'apiKeys';
export const END_USERS = 'apiEndUsers';
export const AUDIT = 'apiAudit';
export const LOGS = 'apiLogs';

export const integrationPath = (id: string) => `${INTEGRATIONS}/${id}`;
export const keyPath = (id: string) => `${KEYS}/${id}`;

/** The stored key record (the hash never leaves the server). */
export interface KeyRecord {
  id: string;
  integrationId: string;
  name: string;
  mode: KeyMode;
  hash: string;
  display: string;
  status: KeyStatus;
  expiresAt: number | null;
  limits: KeyLimits | null;
  createdAt: number | null;
  createdBy: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  rotatedFrom: string | null;
  rotatedTo: string | null;
}

const time = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

export function toKeyRecord(id: string, raw: Record<string, unknown>): KeyRecord {
  const status: KeyStatus = raw.status === 'active' || raw.status === 'disabled' ? raw.status : 'revoked';
  return {
    id,
    integrationId: typeof raw.integrationId === 'string' ? raw.integrationId : '',
    name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : 'Key',
    mode: raw.mode === 'test' ? 'test' : 'live',
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    display: typeof raw.display === 'string' ? raw.display : '',
    status,
    expiresAt: time(raw.expiresAt),
    limits: normalizeKeyLimits(raw.limits),
    createdAt: time(raw.createdAt),
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    lastUsedAt: time(raw.lastUsedAt),
    revokedAt: time(raw.revokedAt),
    rotatedFrom: typeof raw.rotatedFrom === 'string' ? raw.rotatedFrom : null,
    rotatedTo: typeof raw.rotatedTo === 'string' ? raw.rotatedTo : null,
  };
}

/** What the dashboard sees of a key: never the hash. */
export function keyView(k: KeyRecord): ApiKeyView {
  const { hash: _hash, ...view } = k;
  void _hash;
  return view;
}

export async function loadIntegration(db: Firestore, id: string): Promise<IntegrationConfig | null> {
  if (!/^int_[a-f0-9]{16}$/.test(id)) return null;
  const doc = await db.get<Record<string, unknown>>(integrationPath(id));
  return doc ? normalizeIntegration(id, doc.data) : null;
}

export async function loadKey(db: Firestore, id: string): Promise<KeyRecord | null> {
  if (!/^key_[a-f0-9]{16}$/.test(id)) return null;
  const doc = await db.get<Record<string, unknown>>(keyPath(id));
  return doc ? toKeyRecord(id, doc.data) : null;
}

export async function listKeys(db: Firestore, integrationId: string): Promise<KeyRecord[]> {
  const rows = await db.list<Record<string, unknown>>(KEYS, { where: [['integrationId', 'EQUAL', integrationId]], limit: 100 });
  return rows.map((r) => toKeyRecord(r.id, r.data)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function listIntegrations(db: Firestore): Promise<IntegrationConfig[]> {
  const rows = await db.list<Record<string, unknown>>(INTEGRATIONS, { limit: 500 });
  return rows.map((r) => normalizeIntegration(r.id, r.data)).filter((i) => i.status !== 'deleted');
}

/* ------------------------------------------------------------------ end users */

/** Application user ids: 1-128 characters, letters, digits and . _ : @ - */
export const END_USER_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
/** Requests without an end user act for the application itself. */
export const APP_USER = '_app';

/** The Atlas AI data space of one end user of one application. */
export function endUserUid(integrationId: string, externalUserId: string): string {
  return `apiu_${shortHash(`${integrationId}:${externalUserId}`, 28)}`;
}

/** The end user as shown in logs: never the application's raw user id. */
export const endUserRef = (euid: string) => euid.slice(5, 17);
