import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountBlock } from '../server/access.js';
import { purgeAccount, purgeDue, reactivateAccount, restoreAccount, scheduleDeletion, suspendAccount } from '../server/account/lifecycle.js';
import { setAccountAdmin } from '../server/admin.js';
import { phoneKey } from '../server/auth/otp.js';
import { stats, type AdminUserRow } from '../api/admin.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

const SECRET = 'k'.repeat(64);
const admin = { uid: 'admin1', email: 'boss@example.com' };
let db: FakeDb;
let accounts: FakeAccounts;
const now = Date.parse('2026-11-08T10:00:00Z');

beforeEach(() => {
  process.env.OTP_HMAC_SECRET = SECRET;
  db = new FakeDb();
  accounts = new FakeAccounts();
  setAccountAdmin(accounts);
  accounts.add({ uid: 'u1', email: 'Kofi@Example.com', claims: { phoneVerified: true } });
  db.docs.set('users/u1', { displayName: 'Kofi', accountStatus: 'active', phoneNumber: '+233241234567' });
  db.docs.set('users/u1/conversations/c1', { title: 'Hello' });
  db.docs.set('users/u1/conversations/c1/messages/m1', { role: 'user', content: 'hi' });
  db.docs.set('users/u1/memories/x', { text: 'Likes tea' });
  db.docs.set(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`, { uid: 'u1' });
  db.docs.set('otp/u1', { codeHash: 'h' });
  db.docs.set('config/access', { allowedEmails: ['kofi@example.com', 'other@example.com'], adminEmails: [] });
  db.docs.set('users/u2', { accountStatus: 'active' });
});

afterEach(() => {
  setAccountAdmin(null);
  delete process.env.OTP_HMAC_SECRET;
});

const events = (uid: string) => [...db.docs.entries()].filter(([p]) => p.startsWith(`users/${uid}/securityEvents/`)).map(([, e]) => e.type);
const logs = () => [...db.docs.entries()].filter(([p]) => p.startsWith('adminLogs/')).map(([, e]) => e.action);

describe('account lifecycle', () => {
  it('suspension disables sign-in, revokes sessions and blocks API access', async () => {
    const target = (await accounts.get('u1'))!;
    await suspendAccount(db.asFirestore(), admin, target, 'spam', now);
    expect(accounts.users.get('u1')!.disabled).toBe(true);
    expect(accounts.updates.at(-1)!.change).toMatchObject({ disabled: true, revokeSessions: true });
    const p = db.docs.get('users/u1')!;
    expect(p).toMatchObject({ accountStatus: 'suspended', suspendedReason: 'spam', sessionsValidAfter: Math.floor(now / 1000) });
    expect(accountBlock(p as never, Math.floor(now / 1000) + 10)?.code).toBe('account_suspended');
    expect(events('u1')).toContain('account_suspended');
    expect(logs()).toContain('user_suspended');

    await reactivateAccount(db.asFirestore(), admin, target, now + 1000);
    expect(accounts.users.get('u1')!.disabled).toBe(false);
    expect(db.docs.get('users/u1')!.accountStatus).toBe('active');
    // the old session stays revoked; a new sign-in works
    expect(accountBlock(db.docs.get('users/u1') as never, Math.floor(now / 1000) - 5)?.code).toBe('session_revoked');
    expect(accountBlock(db.docs.get('users/u1') as never, Math.floor(now / 1000) + 5)).toBeNull();
  });

  it('soft delete keeps data for 30 days and can be restored', async () => {
    const target = (await accounts.get('u1'))!;
    const { purgeAfter } = await scheduleDeletion(db.asFirestore(), admin, target, now);
    expect(purgeAfter).toBe(now + 30 * 86_400_000);
    expect(db.docs.get('users/u1')!.accountStatus).toBe('deleted');
    expect(db.docs.has('users/u1/conversations/c1/messages/m1')).toBe(true);
    // not yet due
    expect((await purgeDue(db.asFirestore(), now + 86_400_000)).purged).toEqual([]);
    await restoreAccount(db.asFirestore(), admin, target, now + 1000);
    expect(db.docs.get('users/u1')!.accountStatus).toBe('active');
    expect(accounts.users.get('u1')!.disabled).toBe(false);
    expect(logs()).toEqual(expect.arrayContaining(['user_deletion_scheduled', 'user_restored']));
  });

  it('purge removes all user data, the phone mapping, allowlist entry and the Auth account', async () => {
    const target = (await accounts.get('u1'))!;
    await scheduleDeletion(db.asFirestore(), admin, target, now);
    const r = await purgeDue(db.asFirestore(), now + 31 * 86_400_000);
    expect(r).toEqual({ purged: ['u1'], failed: [] });
    expect([...db.docs.keys()].filter((p) => p.startsWith('users/u1'))).toEqual([]);
    expect(db.docs.has(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`)).toBe(false);
    expect(db.docs.has('otp/u1')).toBe(false);
    expect(db.docs.get('config/access')!.allowedEmails).toEqual(['other@example.com']);
    expect(accounts.users.has('u1')).toBe(false);
    // other users untouched
    expect(db.docs.has('users/u2')).toBe(true);
    expect(logs()).toContain('user_purged');
  });

  it('purge does not delete a phone mapping that belongs to someone else', async () => {
    db.docs.set(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`, { uid: 'u2' });
    await purgeAccount(db.asFirestore(), admin, (await accounts.get('u1'))!);
    expect(db.docs.get(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`)).toEqual({ uid: 'u2' });
  });

  it('scheduled purge skips accounts re-enabled in Auth', async () => {
    const target = (await accounts.get('u1'))!;
    await scheduleDeletion(db.asFirestore(), admin, target, now);
    accounts.users.get('u1')!.disabled = false;
    expect((await purgeDue(db.asFirestore(), now + 31 * 86_400_000)).purged).toEqual([]);
    expect(db.docs.has('users/u1/memories/x')).toBe(true);
  });
});

describe('admin statistics', () => {
  const r = (o: Partial<AdminUserRow>): AdminUserRow => ({
    uid: 'x',
    email: null,
    name: 'x',
    photoURL: null,
    providers: ['password'],
    createdAt: Date.parse('2026-01-01'),
    lastLoginAt: null,
    status: 'active',
    phoneMasked: null,
    phoneVerified: false,
    emailVerified: true,
    approved: true,
    admin: false,
    owner: false,
    purgeAfter: null,
    ...o,
  });
  it('counts from the rows given, with no sample data', () => {
    expect(stats([], now)).toMatchObject({ total: 0, active: 0, google: 0 });
    const s = stats(
      [
        r({ providers: ['google.com'], phoneVerified: true, createdAt: now - 86_400_000 }),
        r({ status: 'suspended' }),
        r({ status: 'deleted', providers: ['password', 'google.com'] }),
      ],
      now,
    );
    expect(s).toMatchObject({ total: 3, active: 1, suspended: 1, pendingDeletion: 1, newUsers: 1, google: 2, password: 2, phoneVerified: 1, phoneUnverified: 2, phoneRequiredPending: 2 });
  });
});
