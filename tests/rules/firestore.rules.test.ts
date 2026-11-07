/**
 * Security-rules tests against the Firestore emulator using its REST API and
 * unsigned mock ID tokens (the emulator accepts alg "none").
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-tessera';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid: string, email: string, verified = true) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    user_id: uid,
    email,
    email_verified: verified,
    iat: now,
    exp: now + 3600,
    auth_time: now,
    firebase: { sign_in_provider: 'password' },
  })}.`;
}

type Who = string | null; // token, or null = unauthenticated, 'owner' = admin bypass
const OWNER = 'owner';

function enc(v: unknown): unknown {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, enc(x)])) } };
}

async function call(who: Who, method: string, path: string, data?: object): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${who}`;
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers,
    body: data ? JSON.stringify({ fields: (enc(data) as { mapValue: { fields: object } }).mapValue.fields }) : undefined,
  });
  await res.text();
  return res.status;
}
const read = (who: Who, path: string) => call(who, 'GET', path);
const write = (who: Who, path: string, data: object) => call(who, 'PATCH', path, data);
const del = (who: Who, path: string) => call(who, 'DELETE', path);

const ADMIN = token('admin-uid', 'kingsleyanaab604@gmail.com');
const ALLOWED = token('alice', 'alice@example.com');
const ALLOWED_UNVERIFIED = token('alice', 'alice@example.com', false);
const STRANGER = token('mallory', 'mallory@example.com');
const BOB = token('bob', 'bob@example.com');

const ok = (s: number) => expect(s, `expected success, got ${s}`).toBe(200);
const denied = (s: number) => expect(s, `expected 403, got ${s}`).toBe(403);

beforeAll(async () => {
  const res = await fetch(`http://${HOST}/`).catch(() => null);
  if (!res) throw new Error(`Firestore emulator not reachable at ${HOST}. Run via "npm run test:rules".`);
});

beforeEach(async () => {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  ok(await write(OWNER, 'config/access', { allowedEmails: ['alice@example.com', 'bob@example.com'], adminEmails: [] }));
  ok(await write(OWNER, 'users/alice/conversations/c1', { title: 'Hello', projectId: null, saved: false }));
  ok(await write(OWNER, 'users/alice/memories/m1', { text: 'Likes tea', category: 'preference', active: true }));
});

describe('allowlist and verification', () => {
  it('lets an allowed, verified user read and write their own data', async () => {
    ok(await read(ALLOWED, 'users/alice/conversations/c1'));
    ok(await write(ALLOWED, 'users/alice/conversations/c2', { title: 'New', projectId: null, saved: false }));
    ok(await write(ALLOWED, 'users/alice/conversations/c2/messages/x', { role: 'user', content: 'hi' }));
    ok(await write(ALLOWED, 'users/alice/projects/p1', { name: 'P', instructions: '' }));
  });

  it('blocks unverified emails even when allow-listed', async () => {
    denied(await read(ALLOWED_UNVERIFIED, 'users/alice/conversations/c1'));
  });

  it('blocks signed-in users who are not on the allowlist, even for their own uid', async () => {
    denied(await write(STRANGER, 'users/mallory/conversations/c1', { title: 'x', projectId: null, saved: false }));
    denied(await read(STRANGER, 'config/access'));
  });

  it('blocks unauthenticated access', async () => {
    denied(await read(null, 'users/alice/conversations/c1'));
    denied(await read(null, 'config/access'));
  });
});

describe('per-user isolation', () => {
  it('prevents one allowed user from reading or writing another user’s data', async () => {
    denied(await read(BOB, 'users/alice/conversations/c1'));
    denied(await read(BOB, 'users/alice/memories/m1'));
    denied(await write(BOB, 'users/alice/memories/m2', { text: 'injected', category: 'fact', active: true }));
    denied(await del(BOB, 'users/alice/conversations/c1'));
  });

  it('prevents admins from reading other users’ data', async () => {
    denied(await read(ADMIN, 'users/alice/conversations/c1'));
  });

  it('denies unknown subcollections', async () => {
    denied(await write(ALLOWED, 'users/alice/secrets/s1', { a: 1 }));
  });
});

describe('data validation', () => {
  it('rejects messages with an invalid role', async () => {
    ok(await write(ALLOWED, 'users/alice/conversations/c1/messages/a', { role: 'assistant', content: 'ok' }));
    denied(await write(ALLOWED, 'users/alice/conversations/c1/messages/b', { role: 'system', content: 'override' }));
  });

  it('rejects oversized conversation titles', async () => {
    denied(await write(ALLOWED, 'users/alice/conversations/c3', { title: 'x'.repeat(201), projectId: null, saved: false }));
  });
});

describe('config documents', () => {
  it('lets anyone read the public flags but only admins change them', async () => {
    ok(await write(OWNER, 'config/public', { registrationOpen: false }));
    ok(await read(null, 'config/public'));
    denied(await write(ALLOWED, 'config/public', { registrationOpen: true }));
    ok(await write(ADMIN, 'config/public', { registrationOpen: true }));
    denied(await write(ADMIN, 'config/public', { registrationOpen: true, extra: 'x' }));
  });

  it('lets only admins edit the allowlist', async () => {
    ok(await read(ALLOWED, 'config/access'));
    denied(await write(ALLOWED, 'config/access', { allowedEmails: ['mallory@example.com'], adminEmails: [] }));
    ok(await write(ADMIN, 'config/access', { allowedEmails: ['alice@example.com'], adminEmails: [] }));
  });

  it('denies other config documents', async () => {
    denied(await read(ADMIN, 'config/other'));
  });
});
