import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountBlock } from '../server/access.js';
import { purgeAccount, purgeDue, reactivateAccount, restoreAccount, scheduleDeletion, suspendAccount } from '../server/account/lifecycle.js';
import { cleanupPurgedRecords, eventTime } from '../server/account/retention.js';
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

  it('a removed device is signed out; other devices and later sign-ins are not', () => {
    const p = { accountStatus: 'active', removedDevices: { aaa: 1000 } };
    expect(accountBlock(p as never, 990, 'aaa')?.code).toBe('device_removed');
    expect(accountBlock(p as never, 1000, 'aaa')?.code).toBe('device_removed');
    expect(accountBlock(p as never, 1001, 'aaa')).toBeNull(); // signed in again afterwards
    expect(accountBlock(p as never, 990, 'bbb')).toBeNull(); // another device
    expect(accountBlock(p as never, 990, null)).toBeNull();
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
    lastActiveAt: null,
    status: 'active',
    phoneMasked: null,
    phoneVerified: false,
    emailVerified: true,
    approved: true,
    accessStatus: 'approved',
    admin: false,
    owner: false,
    purgeAfter: null,
    consent: null,
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

  it('counts who was active now, in 24 hours and in 7 days', () => {
    const s = stats(
      [
        r({ lastActiveAt: now - 2 * 60_000 }),
        r({ lastActiveAt: now - 3 * 3_600_000 }),
        r({ lastActiveAt: now - 3 * 86_400_000 }),
        r({ lastActiveAt: now - 40 * 86_400_000 }),
        r({ lastActiveAt: null }),
      ],
      now,
    );
    expect(s).toMatchObject({ activeNow: 1, activeToday: 2, activeWeek: 3 });
  });
});

describe('retention after permanent deletion', () => {
  const DAY = 86_400_000;
  it('keeps the access request and admin logs for 30 days after the purge, then deletes them', async () => {
    db.docs.set('accessRequests/u1', { emailNorm: 'kofi@example.com', status: 'approved' });
    db.docs.set('accessRequests/u2', { emailNorm: 'ama@example.com', status: 'approved' });
    db.docs.set('adminLogs/00000000000001_aaaa', { action: 'user_approved', targetUid: 'u1', targetEmail: 'kofi@example.com' });
    db.docs.set('adminLogs/00000000000002_bbbb', { action: 'user_approved', targetUid: 'u2', targetEmail: 'ama@example.com' });
    const t0 = Date.now();
    await purgeAccount(db.asFirestore(), admin, (await accounts.get('u1'))!);

    expect(await cleanupPurgedRecords(db.asFirestore(), t0 + 29 * DAY)).toEqual({ accounts: 0, removed: 0 });
    expect(db.docs.has('accessRequests/u1')).toBe(true);

    const r = await cleanupPurgedRecords(db.asFirestore(), t0 + 31 * DAY);
    expect(r.accounts).toBe(1);
    expect(db.docs.has('accessRequests/u1')).toBe(false);
    const remaining = [...db.docs.entries()].filter(([p]) => p.startsWith('adminLogs/')).map(([, e]) => e);
    expect(remaining.some((e) => e.targetUid === 'u1' || e.targetEmail === 'kofi@example.com')).toBe(false);
    // other accounts untouched, and the cleanup itself is logged without personal details
    expect(db.docs.has('accessRequests/u2')).toBe(true);
    expect(remaining.some((e) => e.targetUid === 'u2')).toBe(true);
    expect(remaining.find((e) => e.action === 'retention_cleanup')).toMatchObject({ adminUid: 'system', targetEmail: null });
  });

  it('leaves the records alone if the account exists again', async () => {
    db.docs.set('accessRequests/u1', { status: 'approved' });
    const t0 = Date.now();
    await purgeAccount(db.asFirestore(), admin, (await accounts.get('u1'))!);
    db.docs.set('users/u1', { accountStatus: 'active' });
    expect((await cleanupPurgedRecords(db.asFirestore(), t0 + 31 * DAY)).removed).toBe(0);
    expect(db.docs.has('accessRequests/u1')).toBe(true);
  });

  it('reads the time from an event id', () => {
    expect(eventTime('00001731024000000_ab12cd34')).toBe(1731024000000);
    expect(eventTime('nonsense')).toBeNull();
  });
});
