/**
 * Maintenance mode (server/maintenance.ts): only the Super Admin can switch it; while it is on,
 * signed-in non-admins are refused by every protected endpoint (503 maintenance) and the access
 * check tells the app to show the notice; administrators keep working. Runs the real endpoints
 * against an in-memory database and accounts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as accountPOST } from '../api/account.js';
import { POST as adminPOST } from '../api/admin.js';
import { GET as configGET } from '../api/config.js';
import { clearAccessCache } from '../server/access.js';
import { setAccountAdmin, setAdminDb } from '../server/admin.js';
import { setTokenVerifier } from '../server/auth.js';
import { clearMaintenanceCache } from '../server/maintenance.js';
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

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
async function body(res: Response) {
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
}
const admin = async (token: string, b: object) =>
  body(await adminPOST(new Request('http://localhost/api/admin', { method: 'POST', headers: headers(token), body: JSON.stringify(b) })));
const config = async (token: string) => body(await configGET(new Request('http://localhost/api/config', { headers: headers(token) })));
const access = async (token: string) =>
  body(await accountPOST(new Request('http://localhost/api/account', { method: 'POST', headers: headers(token), body: JSON.stringify({ action: 'access' }) })));

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
  clearMaintenanceCache();
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  setAdminDb(null);
  setAccountAdmin(null);
  setTokenVerifier(null);
  tokens.clear();
});

describe('maintenance mode', () => {
  it('locks out signed-in users (not administrators) until it is turned off', async () => {
    const owner = person('owner', OWNER);
    const user = person('u1', 'user@example.com');
    expect((await config(user)).status).toBe(200);
    expect((await access(user)).body.maintenance).toBeNull();

    const on = await admin(owner, { action: 'maintenanceSet', enabled: true, title: 'Back soon', message: 'Upgrading the servers.' });
    expect(on.status).toBe(200);
    expect((on.body.maintenance as { enabled: boolean }).enabled).toBe(true);

    const refused = await config(user);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({ code: 'maintenance', message: 'Upgrading the servers.', title: 'Back soon' });
    const a = await access(user);
    expect(a.status).toBe(200);
    expect(a.body.state).toBe('approved');
    expect(a.body.maintenance).toEqual({ title: 'Back soon', message: 'Upgrading the servers.' });

    // the Super Admin keeps working and is never shown the notice
    expect((await config(owner)).status).toBe(200);
    expect((await access(owner)).body.maintenance).toBeNull();

    expect((await admin(owner, { action: 'maintenanceSet', enabled: false })).status).toBe(200);
    expect((await config(user)).status).toBe(200);
    expect((await access(user)).body.maintenance).toBeNull();

    const actions = db.under('adminLogs/').map((p) => (db.docs.get(p) as { action: string }).action);
    expect(actions).toEqual(expect.arrayContaining(['maintenance_on', 'maintenance_off']));
  });

  it('only the Super Admin can switch it; appointed administrators can view it and keep access', async () => {
    person('owner', OWNER);
    db.docs.set('config/access', { allowedEmails: [], adminEmails: ['ops@example.com'] });
    clearAccessCache();
    const ops = person('ops', 'ops@example.com');
    const user = person('u1', 'user@example.com');

    const denied = await admin(ops, { action: 'maintenanceSet', enabled: true });
    expect(denied.status).toBe(403);
    expect((denied.body.error as { code: string }).code).toBe('not_super_admin');
    expect(db.docs.has('config/maintenance')).toBe(false);

    const view = await admin(ops, { action: 'maintenanceGet' });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ superAdmin: false, maintenance: { enabled: false } });

    // ordinary users cannot reach the admin endpoint at all
    expect((await admin(user, { action: 'maintenanceSet', enabled: true })).status).toBe(403);

    db.docs.set('config/maintenance', { enabled: true, title: 'Closed', message: 'Maintenance.' });
    clearMaintenanceCache();
    expect((await config(ops)).status).toBe(200);
    expect((await config(user)).status).toBe(503);
  });

  it('refuses an empty or over-long notice', async () => {
    const owner = person('owner', OWNER);
    expect((await admin(owner, { action: 'maintenanceSet', enabled: true, title: '' })).status).toBe(400);
    expect((await admin(owner, { action: 'maintenanceSet', enabled: true, message: 'x'.repeat(601) })).status).toBe(400);
    expect(db.docs.has('config/maintenance')).toBe(false);
  });
});
