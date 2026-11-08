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
  return emulated() || parseServiceAccount(env().serviceAccount) !== null;
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
  return new Firestore(await adminToken());
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
  const found = await identity<{ users?: { customAttributes?: string }[] }>('accounts:lookup', { localId: [uid] });
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(found.users?.[0]?.customAttributes ?? '{}') as Record<string, unknown>;
  } catch {
    current = {};
  }
  await identity('accounts:update', { localId: uid, customAttributes: JSON.stringify({ ...current, ...claims }) });
}
