/**
 * Self-service account deletion (Settings › Security › Delete account) through
 * the real api/account endpoint against an in-memory database and accounts:
 * needs a fresh email code, refuses administrators, and schedules the same
 * 30-day recoverable deletion an administrator would.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as accountPOST } from '../api/account.js';
import { clearAccessCache } from '../server/access.js';
import { DELETION_GRACE_DAYS } from '../server/account/lifecycle.js';
import { setAccountAdmin, setAdminDb } from '../server/admin.js';
import { setTokenVerifier } from '../server/auth.js';
import { render } from '../server/email/templates.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../server/shared/legal.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

const OWNER = 'owner@example.com';
const nowSec = () => Math.floor(Date.now() / 1000);
const tokens = new Map<string, Record<string, unknown>>();
let db: FakeDb;
let accounts: FakeAccounts;

function person(uid: string, email: string, verified = true) {
  accounts.add({ uid, email, providers: ['password'] });
  db.docs.set(`users/${uid}`, {
    email,
    accessStatus: 'approved',
    accountStatus: 'active',
    consent: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    settings: {},
  });
  const tok = `tok-${uid}`;
  tokens.set(tok, { sub: uid, email, email_verified: verified, auth_time: nowSec() - 30, firebase: { sign_in_provider: 'password' } });
  return tok;
}

const stepUp = (uid: string) => db.docs.set(`emailCodes/${uid}_sensitive`, { stepUpUntil: Date.now() + 5 * 60_000 });

async function del(token: string, body: object = { action: 'deleteAccount', confirm: 'DELETE' }) {
  const res = await accountPOST(
    new Request('http://localhost/api/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { purgeAfter?: number; error?: { code?: string } } & Record<string, unknown> };
}

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

describe('delete your own account', () => {
  it('needs a confirmed email code first', async () => {
    const t = person('u1', 'ama@example.com');
    const r = await del(t);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('step_up_required');
    expect(db.docs.get('users/u1')).toMatchObject({ accountStatus: 'active' });
  });

  it('needs the word DELETE', async () => {
    const t = person('u1', 'ama@example.com');
    stepUp('u1');
    expect((await del(t, { action: 'deleteAccount', confirm: 'yes' })).status).toBe(400);
  });

  it('needs a verified email address', async () => {
    const t = person('u1', 'ama@example.com', false);
    stepUp('u1');
    expect((await del(t)).status).toBe(403);
    expect(db.docs.get('users/u1')).toMatchObject({ accountStatus: 'active' });
  });

  it('refuses administrator accounts', async () => {
    const t = person('boss', OWNER);
    stepUp('boss');
    const r = await del(t);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('admin_account');
    expect(db.docs.get('users/boss')).toMatchObject({ accountStatus: 'active' });
  });

  it('switches the account off and schedules deletion after 30 days', async () => {
    const t = person('u1', 'ama@example.com');
    stepUp('u1');
    const before = Date.now();
    const r = await del(t);
    expect(r.status).toBe(200);
    const purgeAfter = r.body.purgeAfter!;
    expect(purgeAfter - before).toBeGreaterThanOrEqual(DELETION_GRACE_DAYS * 86_400_000 - 1000);
    expect(db.docs.get('users/u1')).toMatchObject({ accountStatus: 'deleted', purgeAfter });
    expect(accounts.updates.at(-1)).toMatchObject({ uid: 'u1', change: { disabled: true, revokeSessions: true } });
    const events = [...db.docs.entries()].filter(([k]) => k.startsWith('users/u1/securityEvents/')).map(([, v]) => v);
    expect(events).toContainEqual(expect.objectContaining({ type: 'account_deletion_scheduled', by: 'user' }));
    const audit = [...db.docs.entries()].filter(([k]) => k.startsWith('adminLogs/')).map(([, v]) => v as { detail?: string });
    expect(audit.some((a) => a.detail?.includes('requested by the account holder'))).toBe(true);
  });
});

describe('deletion email', () => {
  it('gives the permanent deletion date and how to restore the account', () => {
    const at = Date.parse('2026-11-13T10:00:00Z');
    const r = render('account_deletion', { name: 'Ama', at, purgeAfter: at + 30 * 86_400_000, contact: 'help@example.com' }, 'https://x.test');
    expect(r.subject).toBe('Your Atlas AI account will be deleted');
    expect(r.text).toContain('13 December 2026');
    expect(r.text).toContain('help@example.com');
  });
});
