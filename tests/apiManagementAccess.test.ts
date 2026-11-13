/**
 * API Management is Super Admin only, enforced by the server (api/admin "apiManagement"):
 * unauthenticated callers, ordinary users and appointed administrators are refused, and nothing
 * is created. Runs the real endpoint against an in-memory database and accounts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as adminPOST } from '../api/admin.js';
import { clearAccessCache } from '../server/access.js';
import { setAccountAdmin, setAdminDb } from '../server/admin.js';
import { setTokenVerifier } from '../server/auth.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../server/shared/legal.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

const OWNER = 'owner@example.com';
const now = () => Math.floor(Date.now() / 1000);
const tokens = new Map<string, Record<string, unknown>>();
let db: FakeDb;
let accounts: FakeAccounts;

function person(uid: string, email: string) {
  accounts.add({ uid, email, providers: ['google.com'] });
  db.docs.set(`users/${uid}`, {
    email,
    accessStatus: 'approved',
    accountStatus: 'active',
    consent: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    lastAuthTime: now() + 10_000,
    settings: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const tok = `tok-${uid}-${tokens.size}`;
  tokens.set(tok, { sub: uid, email, email_verified: true, auth_time: now() - 30, firebase: { sign_in_provider: 'google.com' } });
  return tok;
}

async function admin(token: string | null, body: object) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await adminPOST(new Request('http://localhost/api/admin', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
}

const create = {
  action: 'apiManagement',
  op: { op: 'create', config: { name: 'Messenger', appType: 'mobile', allowedEnvironments: ['main'], permissions: ['chat'] }, firstKey: { name: 'server', mode: 'live' } },
};

beforeEach(() => {
  process.env.ADMIN_EMAILS = OWNER;
  db = new FakeDb();
  accounts = new FakeAccounts();
  setAdminDb(db.asFirestore());
  setAccountAdmin(accounts);
  setTokenVerifier(async (t) => {
    const p = tokens.get(t);
    if (!p) throw new Error('bad token');
    return p;
  });
  clearAccessCache();
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  setAdminDb(null);
  setAccountAdmin(null);
  setTokenVerifier(null);
  tokens.clear();
});

describe('API Management access', () => {
  it('refuses unauthenticated callers, ordinary users and appointed administrators', async () => {
    expect((await admin(null, create)).status).toBe(401);
    expect((await admin(person('u1', 'user@example.com'), create)).status).toBe(403);
    db.docs.set('config/access', { allowedEmails: [], adminEmails: ['ops@example.com'] });
    clearAccessCache();
    const ops = await admin(person('ops', 'ops@example.com'), create);
    expect(ops.status).toBe(403);
    expect((ops.body.error as { code: string }).code).toBe('not_super_admin');
    expect(db.under('apiIntegrations/').length + db.under('apiKeys/').length).toBe(0);
  });

  it('lets the Super Admin create an integration; the key is returned once and only its hash is stored', async () => {
    const r = await admin(person('sa', OWNER), create);
    expect(r.status).toBe(200);
    const key = r.body.key as { secret: string; view: { id: string } };
    expect(key.secret).toMatch(/^atlas_live_/);
    expect(JSON.stringify([...db.docs.entries()])).not.toContain(key.secret);
    // a later read of the integration never includes the secret
    const id = (r.body.integration as { id: string }).id;
    const got = await admin(person('sa2', OWNER), { action: 'apiManagement', op: { op: 'get', id } });
    expect(JSON.stringify(got.body)).not.toContain(key.secret);
  });

  it('rejects unknown operations and bad input', async () => {
    const t = person('sa', OWNER);
    expect((await admin(t, { action: 'apiManagement', op: { op: 'dropEverything' } })).status).toBe(400);
    expect((await admin(t, { action: 'apiManagement', op: { op: 'get', id: '../../users' } })).status).toBe(400);
  });
});
