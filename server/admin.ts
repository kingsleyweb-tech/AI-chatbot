/**
 * Privileged access for the few operations users must never perform
 * themselves: one-time-code records, phone-number ownership and the
 * phoneVerified custom claim. Uses a service account (FIREBASE_SERVICE_ACCOUNT,
 * server-only) exchanged for a short-lived OAuth token; against the local
 * emulators it uses the emulator's admin bypass instead.
 */
import { importPKCS8, SignJWT } from 'jose';
import { env } from './env.js';
import { Firestore } from './firestore.js';
import { HttpError } from './http.js';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cached: { token: string; exp: number } | null = null;

function emulated() {
  const e = env();
  return Boolean(e.firestoreEmulator && e.authEmulator);
}

function parseServiceAccount(raw: string): ServiceAccount | null {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text) as ServiceAccount;
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

/** True when privileged operations (and so phone verification) can run. */
export function adminConfigured(): boolean {
  return Boolean(dbOverride) || emulated() || parseServiceAccount(env().serviceAccount) !== null;
}

export async function adminToken(): Promise<string> {
  if (emulated()) return 'owner';
  if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
  const sa = parseServiceAccount(env().serviceAccount);
  if (!sa) throw new HttpError(503, 'admin_unconfigured', 'Phone verification is not configured on the server yet.');
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/cloud-platform' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`[admin] token exchange failed: ${res.status}`);
    throw new HttpError(503, 'admin_unavailable', 'The verification service is temporarily unavailable.');
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

/** Firestore client that bypasses security rules. Only for server-owned documents. */
export async function adminDb(): Promise<Firestore> {
  if (dbOverride) return dbOverride;
  const db = new Firestore(await adminToken());
  db.admin = true;
  return db;
}

function identityBase() {
  const e = env();
  const host = emulated() ? `http://${e.authEmulator}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
  return `${host}/v1/projects/${e.projectId}`;
}

async function identity<T>(method: string, body: object): Promise<T> {
  const res = await fetch(`${identityBase()}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`[admin] ${method} failed: ${res.status}`);
    throw new HttpError(502, 'auth_admin_failed', 'Could not update the account. Please try again.');
  }
  return (await res.json()) as T;
}

/** Merge custom claims into the user's ID token (visible after the client refreshes its token). */
export async function mergeCustomClaims(uid: string, claims: Record<string, unknown>) {
  await accountAdmin().mergeClaims(uid, claims);
}

/* ------------------------------ account admin ------------------------------ */

/** The parts of a Firebase Auth account the app uses. Never includes password hashes or tokens. */
export interface AuthAccount {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  disabled: boolean;
  /** linked sign-in methods: password, google.com, apple.com ... */
  providers: string[];
  createdAt: number | null;
  lastLoginAt: number | null;
  /** refresh tokens issued before this time (ms) are revoked */
  validSince: number | null;
  passwordUpdatedAt: number | null;
  claims: Record<string, unknown>;
}

interface RawAccount {
  localId: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  passwordHash?: string;
  providerUserInfo?: { providerId: string }[];
  createdAt?: string;
  lastLoginAt?: string;
  validSince?: string;
  passwordUpdatedAt?: number;
  customAttributes?: string;
}

export function toAccount(r: RawAccount): AuthAccount {
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(r.customAttributes ?? '{}') as Record<string, unknown>;
  } catch {
    claims = {};
  }
  const providers = (r.providerUserInfo ?? []).map((p) => p.providerId);
  if (r.passwordHash !== undefined && !providers.includes('password')) providers.push('password');
  const num = (v?: string | number) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    uid: r.localId,
    email: r.email?.toLowerCase() ?? null,
    displayName: r.displayName ?? null,
    photoURL: r.photoUrl ?? null,
    emailVerified: r.emailVerified === true,
    disabled: r.disabled === true,
    providers,
    createdAt: num(r.createdAt),
    lastLoginAt: num(r.lastLoginAt),
    validSince: r.validSince ? Number(r.validSince) * 1000 : null,
    passwordUpdatedAt: num(r.passwordUpdatedAt),
    claims,
  };
}

export interface AccountUpdate {
  disabled?: boolean;
  /** revoke every refresh token issued before now */
  revokeSessions?: boolean;
  password?: string;
}

/** Privileged Firebase Auth operations (Identity Toolkit admin API). Replaceable in tests. */
export interface AccountAdmin {
  get(uid: string): Promise<AuthAccount | null>;
  getByEmail(email: string): Promise<AuthAccount | null>;
  list(max?: number): Promise<AuthAccount[]>;
  update(uid: string, change: AccountUpdate): Promise<void>;
  remove(uid: string): Promise<void>;
  mergeClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}

const identityAdmin: AccountAdmin = {
  async get(uid) {
    const r = await identity<{ users?: RawAccount[] }>('accounts:lookup', { localId: [uid] });
    return r.users?.[0] ? toAccount(r.users[0]) : null;
  },
  async getByEmail(email) {
    const r = await identity<{ users?: RawAccount[] }>('accounts:lookup', { email: [email.toLowerCase()] });
    return r.users?.[0] ? toAccount(r.users[0]) : null;
  },
  async list(max = 2500) {
    const out: AuthAccount[] = [];
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ maxResults: '500', ...(pageToken ? { nextPageToken: pageToken } : {}) });
      const res = await fetch(`${identityBase()}/accounts:batchGet?${qs}`, {
        headers: { authorization: `Bearer ${await adminToken()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.error(`[admin] accounts:batchGet failed: ${res.status}`);
        throw new HttpError(502, 'auth_admin_failed', 'Could not load the user list. Please try again.');
      }
      const body = (await res.json()) as { users?: RawAccount[]; nextPageToken?: string };
      out.push(...(body.users ?? []).map(toAccount));
      pageToken = body.users?.length ? (body.nextPageToken ?? '') : '';
    } while (pageToken && out.length < max);
    return out;
  },
  async update(uid, change) {
    const body: Record<string, unknown> = { localId: uid };
    if (change.disabled !== undefined) body.disableUser = change.disabled;
    if (change.revokeSessions) body.validSince = String(Math.floor(Date.now() / 1000));
    if (change.password) body.password = change.password;
    await identity('accounts:update', body);
  },
  async remove(uid) {
    await identity('accounts:delete', { localId: uid });
  },
  async mergeClaims(uid, claims) {
    const found = await identity<{ users?: { customAttributes?: string }[] }>('accounts:lookup', { localId: [uid] });
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(found.users?.[0]?.customAttributes ?? '{}') as Record<string, unknown>;
    } catch {
      current = {};
    }
    const next = { ...current, ...claims };
    for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
    await identity('accounts:update', { localId: uid, customAttributes: JSON.stringify(next) });
  },
};

let adminOverride: AccountAdmin | null = null;
/** test hook */
export function setAccountAdmin(a: AccountAdmin | null) {
  adminOverride = a;
}
export function accountAdmin(): AccountAdmin {
  return adminOverride ?? identityAdmin;
}

let dbOverride: Firestore | null = null;
/** test hook: privileged Firestore client */
export function setAdminDb(db: Firestore | null) {
  dbOverride = db;
}
