/**
 * Security-rules tests against the Firestore emulator using its REST API and
 * unsigned mock ID tokens (the emulator accepts alg "none").
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-tessera';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid: string, email: string, verified = true, opts: { provider?: string; phoneVerified?: boolean; authTime?: number } = {}) {
  const { provider = 'password', phoneVerified = true } = opts;
  const now = Math.floor(Date.now() / 1000);
  const authTime = opts.authTime ?? now;
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    user_id: uid,
    email,
    email_verified: verified,
    iat: now,
    exp: now + 3600,
    auth_time: authTime,
    firebase: { sign_in_provider: provider },
    ...(phoneVerified ? { phoneVerified: true } : {}),
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

describe('knowledge base', () => {
  it('keeps personal knowledge private to its owner (scenario 12)', async () => {
    ok(await write(ALLOWED, 'users/alice/kbCollections/c1', { name: 'Companies and Organizations' }));
    ok(await write(ALLOWED, 'users/alice/kbSources/s1', { collectionId: 'c1', title: 'Soko Aerial notes', type: 'note', status: 'ready' }));
    ok(await write(ALLOWED, 'users/alice/kbSources/s1/chunks/0000', { index: 0, ref: 'Text', text: 'x' }));
    ok(await write(ALLOWED, 'users/alice/kbSources/s1/index/s0', { shard: 0, start: 0, terms: ['soko'] }));
    ok(await read(ALLOWED, 'users/alice/kbSources/s1/chunks/0000'));
    for (const p of ['users/alice/kbCollections/c1', 'users/alice/kbSources/s1', 'users/alice/kbSources/s1/chunks/0000', 'users/alice/kbSources/s1/index/s0']) {
      denied(await read(BOB, p));
      denied(await read(ADMIN, p));
      denied(await write(BOB, p, { title: 'hijack' }));
    }
    denied(await call(BOB, 'GET', 'users/alice/kbSources'));
    denied(await write(ALLOWED, 'users/alice/kbSources/s1/other/1', { a: 1 }));
    denied(await write(ALLOWED, 'users/alice/kbCollections/c2', { name: 'x'.repeat(101) }));
  });

  it('lets approved users read shared knowledge but only admins change it', async () => {
    ok(await write(ADMIN, 'kb/shared/kbCollections/g', { name: 'General Knowledge' }));
    ok(await write(ADMIN, 'kb/shared/kbSources/s1', { collectionId: 'g', title: 'Handbook', type: 'note', status: 'ready' }));
    ok(await write(ADMIN, 'kb/shared/kbSources/s1/chunks/0000', { index: 0, ref: 'Text', text: 'x' }));
    ok(await read(ALLOWED, 'kb/shared/kbSources/s1'));
    ok(await read(BOB, 'kb/shared/kbSources/s1/chunks/0000'));
    denied(await read(STRANGER, 'kb/shared/kbSources/s1'));
    denied(await read(null, 'kb/shared/kbCollections/g'));
    denied(await write(ALLOWED, 'kb/shared/kbCollections/g2', { name: 'Mine' }));
    denied(await write(ALLOWED, 'kb/shared/kbSources/s1', { collectionId: 'g', title: 'Edited', type: 'note', status: 'ready' }));
    denied(await write(ALLOWED, 'kb/shared/kbSources/s1/chunks/0001', { index: 1, ref: 'Text', text: 'y' }));
    denied(await del(ALLOWED, 'kb/shared/kbSources/s1'));
    ok(await del(ADMIN, 'kb/shared/kbSources/s1'));
  });
});

describe('search limits, cache and document subcollections', () => {
  const limits = {
    serpapi: { daily: 8, monthly: 200 },
    tavily: { daily: 30, monthly: 900 },
    research: { maxSearches: 6, maxPageReads: 4 },
    cacheTtlHours: { news: 2, general: 24, reference: 168 },
    providerReserve: 5,
  };

  it('lets approved users read the limits but only admins change them', async () => {
    ok(await write(OWNER, 'config/limits', limits));
    ok(await read(ALLOWED, 'config/limits'));
    denied(await read(STRANGER, 'config/limits'));
    denied(await write(ALLOWED, 'config/limits', limits));
    ok(await write(ADMIN, 'config/limits', { ...limits, serpapi: { daily: 5, monthly: 100 } }));
    denied(await write(ADMIN, 'config/limits', { ...limits, apiKey: 'x' }));
    denied(await write(ADMIN, 'config/limits', { ...limits, providerReserve: 'lots' }));
  });

  it('lets approved users read the AI routing config but only admins change it', async () => {
    const ai = { preferredProvider: 'gemini', defaultModel: 'gemini:gemini-3.5-flash', fallback: 'any' };
    ok(await write(ADMIN, 'config/ai', ai));
    ok(await read(ALLOWED, 'config/ai'));
    denied(await read(STRANGER, 'config/ai'));
    denied(await write(ALLOWED, 'config/ai', ai));
    ok(await write(ADMIN, 'config/ai', { ...ai, preferredProvider: 'openrouter', fallback: 'off', defaultModel: null }));
    denied(await write(ADMIN, 'config/ai', { ...ai, preferredProvider: 'other' }));
    denied(await write(ADMIN, 'config/ai', { ...ai, fallback: 'paid' }));
    denied(await write(ADMIN, 'config/ai', { ...ai, apiKey: 'x' }));
  });

  it('keeps the search cache private to its owner', async () => {
    ok(await write(ALLOWED, 'users/alice/searchCache/k1', { query: 'q', provider: 'serpapi', results: [] }));
    ok(await read(ALLOWED, 'users/alice/searchCache/k1'));
    denied(await read(BOB, 'users/alice/searchCache/k1'));
  });

  it('allows only known document subcollections', async () => {
    ok(await write(ALLOWED, 'users/alice/documents/d1', { name: 'deck.pptx' }));
    ok(await write(ALLOWED, 'users/alice/documents/d1/images/1', { ref: 'Slide 2' }));
    ok(await write(ALLOWED, 'users/alice/documents/d1/summaries/s0', { text: 'x' }));
    denied(await write(ALLOWED, 'users/alice/documents/d1/other/1', { a: 1 }));
    denied(await read(BOB, 'users/alice/documents/d1/images/1'));
  });
});

describe('phone verification', () => {
  const NO_PHONE = token('alice', 'alice@example.com', true, { phoneVerified: false });
  const GOOGLE = token('alice', 'alice@example.com', true, { provider: 'google.com', phoneVerified: false });
  const APPLE = token('alice', 'alice@example.com', true, { provider: 'apple.com', phoneVerified: false });
  const ADMIN_NO_PHONE = token('admin-uid', 'kingsleyanaab604@gmail.com', true, { phoneVerified: false });

  it('email/password users without a verified phone are locked out, even admins', async () => {
    denied(await read(NO_PHONE, 'users/alice/conversations/c1'));
    denied(await write(NO_PHONE, 'users/alice/conversations/c9', { title: 'x', projectId: null, saved: false }));
    denied(await read(NO_PHONE, 'config/access'));
    denied(await read(ADMIN_NO_PHONE, 'config/access'));
  });

  it('Google and Apple sign-ins do not need the phone claim', async () => {
    ok(await read(GOOGLE, 'users/alice/conversations/c1'));
    ok(await read(APPLE, 'users/alice/conversations/c1'));
  });

  it('clients cannot set phone fields or account status on their profile', async () => {
    denied(await write(ALLOWED, 'users/alice', { displayName: 'Alice', phoneVerified: true }));
    denied(await write(ALLOWED, 'users/alice', { displayName: 'Alice', phoneNumber: '+233241234567' }));
    denied(await write(ALLOWED, 'users/alice', { displayName: 'Alice', accountStatus: 'active' }));
    ok(await write(ALLOWED, 'users/alice', { displayName: 'Alice', provider: 'password' }));
  });

  it('server-only verification records are unreadable and unwritable', async () => {
    ok(await write(OWNER, 'otp/alice', { codeHash: 'h', attempts: 0 }));
    ok(await write(OWNER, 'phoneNumbers/abc', { uid: 'alice' }));
    for (const who of [ALLOWED, ADMIN, NO_PHONE, null]) {
      denied(await read(who, 'otp/alice'));
      denied(await write(who, 'otp/alice', { codeHash: 'mine', attempts: 0 }));
      denied(await read(who, 'phoneNumbers/abc'));
      denied(await write(who, 'phoneNumbers/abc', { uid: 'mallory' }));
      denied(await write(who, 'otpStats/2026-11-08', { sent: 0 }));
    }
  });
});

describe('account status, sessions and audit records', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('a suspended or deleted account loses access to its own data immediately', async () => {
    ok(await write(OWNER, 'users/alice', { displayName: 'Alice', accountStatus: 'suspended' }));
    denied(await read(ALLOWED, 'users/alice'));
    denied(await read(ALLOWED, 'users/alice/conversations/c1'));
    denied(await write(ALLOWED, 'users/alice/conversations/c5', { title: 'x', projectId: null, saved: false }));
    ok(await write(OWNER, 'users/alice', { displayName: 'Alice', accountStatus: 'deleted' }));
    denied(await read(ALLOWED, 'users/alice/memories/m1'));
    ok(await write(OWNER, 'users/alice', { displayName: 'Alice', accountStatus: 'active' }));
    ok(await read(ALLOWED, 'users/alice/memories/m1'));
  });

  it('sessions that started before a revocation are refused', async () => {
    ok(await write(OWNER, 'users/alice', { displayName: 'Alice', accountStatus: 'active', sessionsValidAfter: NOW - 60 }));
    const OLD = token('alice', 'alice@example.com', true, { authTime: NOW - 3600 });
    const FRESH = token('alice', 'alice@example.com', true, { authTime: NOW - 10 });
    denied(await read(OLD, 'users/alice/conversations/c1'));
    ok(await read(FRESH, 'users/alice/conversations/c1'));
  });

  it('clients cannot clear their own suspension or revocation', async () => {
    ok(await write(OWNER, 'users/alice', { displayName: 'Alice', accountStatus: 'active', sessionsValidAfter: NOW - 60 }));
    denied(await call(ALLOWED, 'PATCH', 'users/alice?updateMask.fieldPaths=sessionsValidAfter', { sessionsValidAfter: 0 }));
    denied(await call(ALLOWED, 'PATCH', 'users/alice?updateMask.fieldPaths=purgeAfter', { purgeAfter: 0 }));
    denied(await call(ALLOWED, 'PATCH', 'users/alice?updateMask.fieldPaths=lastAuthTime', { lastAuthTime: 1 }));
    denied(await del(ALLOWED, 'users/alice'));
  });

  it('security events are readable by their owner only and written by the server only', async () => {
    ok(await write(OWNER, 'users/alice/securityEvents/e1', { type: 'login', at: NOW }));
    ok(await read(ALLOWED, 'users/alice/securityEvents/e1'));
    denied(await write(ALLOWED, 'users/alice/securityEvents/e2', { type: 'login', at: NOW }));
    denied(await del(ALLOWED, 'users/alice/securityEvents/e1'));
    denied(await read(BOB, 'users/alice/securityEvents/e1'));
  });

  it('admin activity logs are readable by admins only and never writable by clients', async () => {
    ok(await write(OWNER, 'adminLogs/l1', { action: 'user_suspended' }));
    ok(await read(ADMIN, 'adminLogs/l1'));
    denied(await read(ALLOWED, 'adminLogs/l1'));
    denied(await write(ADMIN, 'adminLogs/l2', { action: 'user_purged' }));
    denied(await del(ADMIN, 'adminLogs/l1'));
  });

  it('recovery records are server-only', async () => {
    ok(await write(OWNER, 'recovery/abc', { codeHash: 'h', attempts: 0 }));
    for (const who of [ALLOWED, ADMIN, null]) {
      denied(await read(who, 'recovery/abc'));
      denied(await write(who, 'recovery/abc', { codeHash: 'mine', attempts: 0 }));
      denied(await read(who, 'otpRecovery/alice'));
      denied(await read(who, 'rateLimits/x'));
    }
  });

  it('project memory and the history index are private to their owner', async () => {
    ok(await write(ALLOWED, 'users/alice/projectMemory/p_alpha', { name: 'Project Alpha' }));
    ok(await write(ALLOWED, 'users/alice/convIndex/s0000', { entries: [] }));
    denied(await read(BOB, 'users/alice/projectMemory/p_alpha'));
    denied(await read(BOB, 'users/alice/convIndex/s0000'));
    denied(await read(ADMIN, 'users/alice/convIndex/s0000'));
  });
});

describe('administrator approval (accessStatus) and access requests', () => {
  const CAROL = token('carol', 'carol@example.com', true, { provider: 'google.com', phoneVerified: false });
  const now = Math.floor(Date.now() / 1000);
  const SERVER = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'atlas-server',
    user_id: 'atlas-server',
    iat: now,
    exp: now + 3600,
    auth_time: now,
    atlasServer: true,
    firebase: { sign_in_provider: 'custom' },
  })}.`;
  const FAKE_SERVER = token('atlas-server', 'x@example.com');

  it('a pending account (not on the allowlist) cannot use the app', async () => {
    ok(await write(OWNER, 'users/carol', { email: 'carol@example.com', accessStatus: 'pending' }));
    denied(await read(CAROL, 'users/carol'));
    denied(await write(CAROL, 'users/carol/conversations/c1', { title: 'x' }));
  });

  it('an approved profile grants access without the allowlist', async () => {
    ok(await write(OWNER, 'users/carol', { email: 'carol@example.com', accessStatus: 'approved' }));
    ok(await read(CAROL, 'users/carol'));
    ok(await write(CAROL, 'users/carol/conversations/c1', { title: 'x' }));
  });

  it('a rejected profile overrides the legacy allowlist', async () => {
    ok(await write(OWNER, 'users/alice', { email: 'alice@example.com', accessStatus: 'rejected' }));
    denied(await read(ALLOWED, 'users/alice/conversations/c1'));
  });

  it('users cannot approve themselves', async () => {
    ok(await write(OWNER, 'users/alice', { email: 'alice@example.com', accessStatus: 'pending', displayName: 'A' }));
    denied(await call(ALLOWED, 'PATCH', 'users/alice?updateMask.fieldPaths=accessStatus', { accessStatus: 'approved' }));
    denied(await call(ALLOWED, 'PATCH', 'users/alice?updateMask.fieldPaths=approvedBy', { approvedBy: 'me' }));
    ok(await call(ALLOWED, 'PATCH', 'users/alice?updateMask.fieldPaths=displayName', { displayName: 'Alice' }));
  });

  it('access requests are readable by admins only and writable by no client', async () => {
    ok(await write(OWNER, 'accessRequests/carol', { uid: 'carol', email: 'carol@example.com', status: 'pending' }));
    ok(await read(ADMIN, 'accessRequests/carol'));
    denied(await read(CAROL, 'accessRequests/carol'));
    denied(await read(ALLOWED, 'accessRequests/carol'));
    denied(await write(CAROL, 'accessRequests/carol', { uid: 'carol', status: 'approved' }));
    denied(await write(ADMIN, 'accessRequests/carol', { uid: 'carol', status: 'approved' }));
  });

  it('the server identity can read and write server-only records; an impostor cannot', async () => {
    ok(await write(SERVER, 'otp/carol', { codeHash: 'h' }));
    ok(await write(SERVER, 'accessRequests/carol', { status: 'pending' }));
    ok(await write(SERVER, 'users/carol', { accessStatus: 'approved' }));
    ok(await read(SERVER, 'config/access'));
    denied(await read(FAKE_SERVER, 'otp/carol'));
    denied(await write(FAKE_SERVER, 'accessRequests/carol', { status: 'approved' }));
    denied(await read(STRANGER, 'otp/carol'));
  });
});
