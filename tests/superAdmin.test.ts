/**
 * Super Admin without the owner's email in any public code.
 *
 * - The owner email comes only from the server variable ADMIN_EMAILS; with it
 *   missing or invalid nobody is Super Admin (fails closed, no built-in fallback).
 * - At sign-in (api/account "access") the server gives that account a
 *   superAdmin custom claim, used by the Firestore rules, and removes it when
 *   the address leaves ADMIN_EMAILS. Responses never list the owner email.
 * - The ownership API (api/admin identityGet / identitySet) refuses
 *   unauthenticated callers, ordinary users and other administrators, and lets
 *   the Super Admin change the record (with an audit entry).
 *
 * Runs the real endpoints against an in-memory database and accounts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as accountPOST } from '../api/account.js';
import { POST as adminPOST } from '../api/admin.js';
import { clearAccessCache } from '../server/access.js';
import { setAccountAdmin, setAdminDb } from '../server/admin.js';
import { setTokenVerifier } from '../server/auth.js';
import { IDENTITY_AUDIT, IDENTITY_PATH, OWNERSHIP_CONFIRM, resetOwnershipCache } from '../server/chat/ownership.js';
import { env, ownerEmails } from '../server/env.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../server/shared/legal.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

const OWNER = 'owner@example.com';
const now = () => Math.floor(Date.now() / 1000);
const tokens = new Map<string, Record<string, unknown>>();
let db: FakeDb;
let accounts: FakeAccounts;

/** a signed-in person: an account, an approved profile and a token */
function person(uid: string, email: string, extra: Record<string, unknown> = {}) {
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
  tokens.set(tok, {
    sub: uid,
    email,
    email_verified: true,
    auth_time: now() - 30,
    firebase: { sign_in_provider: 'google.com' },
    ...extra,
  });
  return tok;
}

async function call(handler: (r: Request) => Promise<Response>, path: string, token: string | null, body: object) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handler(new Request(`http://localhost/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, text: await res.text() };
}
const access = (t: string | null) => call(accountPOST, 'account', t, { action: 'access' });
const admin = (t: string | null, body: object) => call(adminPOST, 'admin', t, body);

const change = {
  action: 'identitySet',
  creator: 'Kingsley Anaab',
  owner: 'Kingsley Anaab',
  aliases: ['Anaab Kingsley'],
  reason: 'Confirming the record after the security review',
  confirmPhrase: OWNERSHIP_CONFIRM,
  confirmEmail: OWNER,
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
  resetOwnershipCache();
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  setAdminDb(null);
  setAccountAdmin(null);
  setTokenVerifier(null);
  tokens.clear();
});

describe('owner email configuration', () => {
  it('comes only from ADMIN_EMAILS and fails closed', () => {
    expect(ownerEmails('Owner@Example.com, second@example.com')).toEqual(['owner@example.com', 'second@example.com']);
    expect(ownerEmails(undefined)).toEqual([]);
    expect(ownerEmails('')).toEqual([]);
    expect(ownerEmails('not-an-email, ,')).toEqual([]);
    delete process.env.ADMIN_EMAILS;
    expect(env().adminEmails).toEqual([]);
  });
});

describe('Super Admin sign-in', () => {
  it('sets the superAdmin claim and asks the browser to refresh its token', async () => {
    const t = person('sa', OWNER);
    const r = await access(t);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ state: 'approved', admin: true, superAdmin: true, refreshToken: true });
    expect(accounts.users.get('sa')!.claims).toMatchObject({ superAdmin: true });
  });

  it('does nothing more once the token carries the claim', async () => {
    const t = person('sa', OWNER, { superAdmin: true });
    accounts.users.get('sa')!.claims = { superAdmin: true };
    expect(JSON.parse((await access(t)).text)).toMatchObject({ superAdmin: true, refreshToken: false });
  });

  it('an ordinary user gets no claim and no admin rights, and no response names the owner', async () => {
    const t = person('u1', 'user@example.com');
    const r = await access(t);
    expect(JSON.parse(r.text)).toMatchObject({ state: 'approved', admin: false, superAdmin: false, refreshToken: false });
    expect(r.text).not.toContain(OWNER);
    expect(accounts.users.get('u1')!.claims).toEqual({});
  });

  it('removes a stale claim when the address is no longer in ADMIN_EMAILS', async () => {
    process.env.ADMIN_EMAILS = 'someone-else@example.com';
    const t = person('sa', OWNER, { superAdmin: true });
    accounts.users.get('sa')!.claims = { superAdmin: true };
    expect(JSON.parse((await access(t)).text)).toMatchObject({ admin: false, superAdmin: false, refreshToken: true });
    expect(accounts.users.get('sa')!.claims).toEqual({});
  });

  it('with ADMIN_EMAILS missing, the former owner address gets nothing (no fallback)', async () => {
    delete process.env.ADMIN_EMAILS;
    const t = person('sa', OWNER);
    expect(JSON.parse((await access(t)).text)).toMatchObject({ admin: false, superAdmin: false });
    expect((await admin(t, { action: 'identityGet' })).status).toBe(403);
  });

  it('an unverified address with the owner email is not Super Admin', async () => {
    const t = person('fake', OWNER, { email_verified: false, phoneVerified: true });
    const r = JSON.parse((await access(t)).text) as { superAdmin?: boolean };
    expect(r.superAdmin ?? false).toBe(false);
    expect(accounts.users.get('fake')!.claims).toEqual({});
  });
});

describe('ownership API', () => {
  it('refuses requests without a valid sign-in', async () => {
    expect((await admin(null, { action: 'identityGet' })).status).toBe(401);
    expect((await admin('forged-token', change)).status).toBe(401);
    expect(db.docs.has(IDENTITY_PATH)).toBe(false);
  });

  it('refuses ordinary users, even with a forged superAdmin claim in an unverified token payload', async () => {
    const t = person('u1', 'user@example.com');
    expect((await admin(t, { action: 'identityGet' })).status).toBe(403);
    expect((await admin(t, { ...change, confirmEmail: 'user@example.com' })).status).toBe(403);
    // the server decides from ADMIN_EMAILS, never from a claim it did not check
    const claimed = person('u2', 'user2@example.com', { superAdmin: true });
    expect((await admin(claimed, { ...change, confirmEmail: 'user2@example.com' })).status).toBe(403);
    expect(db.docs.has(IDENTITY_PATH)).toBe(false);
  });

  it('lets an appointed administrator view, but not change, the record', async () => {
    db.docs.set('config/access', { allowedEmails: [], adminEmails: ['ops@example.com'] });
    const t = person('ops', 'ops@example.com');
    const view = await admin(t, { action: 'identityGet' });
    expect(view.status).toBe(200);
    expect(JSON.parse(view.text)).toMatchObject({ superAdmin: false, history: null, record: { owner: 'Kingsley Anaab' } });
    expect(view.text).not.toContain(OWNER);
    const r = await admin(t, { ...change, owner: 'Ops Person', confirmEmail: 'ops@example.com' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error.code).toBe('not_super_admin');
    expect(db.docs.has(IDENTITY_PATH)).toBe(false);
  });

  it('lets the Super Admin change the record, with an audit entry', async () => {
    const t = person('sa', OWNER);
    const r = await admin(t, { ...change, owner: 'Kingsley Anaab Ltd.' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ superAdmin: true, record: { owner: 'Kingsley Anaab Ltd.', version: 1 } });
    expect(db.docs.get(IDENTITY_PATH)).toMatchObject({ owner: 'Kingsley Anaab Ltd.' });
    expect(db.under(`${IDENTITY_AUDIT}/`)).toHaveLength(1);
    expect(JSON.stringify([...db.docs.entries()].filter(([p]) => p.startsWith('adminLogs/')))).toContain('ownership_changed');
  });

  it('asks the Super Admin to sign in again when the session is old', async () => {
    const t = person('sa', OWNER, { auth_time: now() - 3600 });
    const r = await admin(t, change);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).error.code).toBe('reauth_required');
  });
});
