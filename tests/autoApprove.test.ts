import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAccessCache, decideAccess } from '../server/access.js';
import { acceptTerms } from '../server/account/consent.js';
import { ensureProfile, setAccess, submitRequest } from '../server/account/requests.js';
import type { AuthUser } from '../server/auth.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../server/shared/legal.js';
import { FakeDb } from './fakeDb.js';

const OWNER = ['owner@example.com'];
let db: FakeDb;
const user = (o: Partial<AuthUser> = {}): AuthUser => ({
  uid: 'n1',
  email: 'new@example.com',
  emailVerified: true,
  provider: 'google.com',
  phoneVerified: false,
  authTime: 1,
  token: 't',
  name: 'New Person',
  picture: null,
  ...o,
});
const V = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION };
const entries = (prefix: string) => [...db.docs.entries()].filter(([p]) => p.startsWith(prefix));
const profileOf = (uid: string) => db.docs.get(`users/${uid}`) as Record<string, unknown>;

beforeEach(() => {
  process.env.ADMIN_EMAILS = OWNER[0];
  process.env.OTP_HMAC_SECRET = 'k'.repeat(64);
  db = new FakeDb();
  clearAccessCache();
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.OTP_HMAC_SECRET;
});

describe('automatic approval', () => {
  it('off: a new account is pending (manual approval unchanged)', async () => {
    const p = await ensureProfile(db.asFirestore(), user(), null, undefined, { autoApprove: false });
    expect(p.accessStatus).toBe('pending');
    expect(p.autoApproved).toBe(false);
  });

  it('on: a new Google account is approved at once, in the same write, and logged', async () => {
    const p = await ensureProfile(db.asFirestore(), user(), null, undefined, { autoApprove: true, existing: null });
    expect(p).toMatchObject({ accessStatus: 'approved', approvedBy: 'auto', autoApproved: true });
    expect(profileOf('n1')).toMatchObject({ accessStatus: 'approved', approvedBy: 'auto' });
    expect(entries('adminLogs/').map(([, l]) => l.action)).toEqual(['user_auto_approved']);
    expect(JSON.stringify(entries('users/n1/securityEvents/'))).toContain('access_approved');
  });

  it('on: a new email/password account is approved but still has to verify its phone', async () => {
    const pw = user({ uid: 'p1', email: 'pw@example.com', provider: 'password', phoneVerified: false });
    const p = await ensureProfile(db.asFirestore(), pw, null, 'Pat', { autoApprove: true });
    expect(p.accessStatus).toBe('approved');
    expect(decideAccess(pw, { ...p, consent: { ...V } }, null, OWNER).state).toBe('phone');
    expect(decideAccess({ ...pw, phoneVerified: true }, { ...p, consent: { ...V } }, null, OWNER).state).toBe('approved');
  });

  it('on: existing pending, rejected and suspended accounts are not changed', async () => {
    db.docs.set('users/n1', { email: 'new@example.com', accessStatus: 'pending' });
    db.docs.set('users/r1', { email: 'r@example.com', accessStatus: 'rejected' });
    db.docs.set('users/s1', { email: 's@example.com', accessStatus: 'pending', accountStatus: 'suspended' });
    expect((await ensureProfile(db.asFirestore(), user(), null, undefined, { autoApprove: true })).accessStatus).toBe('pending');
    expect((await ensureProfile(db.asFirestore(), user({ uid: 'r1', email: 'r@example.com' }), null, undefined, { autoApprove: true })).accessStatus).toBe('rejected');
    const s = await ensureProfile(db.asFirestore(), user({ uid: 's1', email: 's@example.com' }), null, undefined, { autoApprove: true });
    expect(s.accessStatus).toBe('pending');
    expect(decideAccess(user({ uid: 's1' }), { ...s, consent: { ...V } }, null, OWNER).state).toBe('suspended');
    expect(entries('adminLogs/')).toHaveLength(0);
  });

  it('on: an email whose earlier request was rejected stays a manual decision', async () => {
    db.docs.set('accessRequests/old', { emailNorm: 'new@example.com', status: 'rejected' });
    const p = await ensureProfile(db.asFirestore(), user(), null, undefined, { autoApprove: true });
    expect(p.accessStatus).toBe('pending');
  });

  it('administrators are approved as before, not by automatic approval', async () => {
    const a = await ensureProfile(db.asFirestore(), user({ uid: 'a1', email: 'owner@example.com' }), null, undefined, { autoApprove: true });
    expect(a.accessStatus).toBe('approved');
    expect(a.autoApproved).toBe(false);
  });

  it('a concurrent second sign-in does not create a duplicate profile or a second log entry', async () => {
    const [x, y] = await Promise.all([
      ensureProfile(db.asFirestore(), user(), null, undefined, { autoApprove: true, existing: null }),
      ensureProfile(db.asFirestore(), user(), null, undefined, { autoApprove: true, existing: null }),
    ]);
    expect(x.accessStatus).toBe('approved');
    expect(y.accessStatus).toBe('approved');
    expect(entries('users/').filter(([p]) => p.split('/').length === 2)).toHaveLength(1);
    expect(entries('adminLogs/')).toHaveLength(1);
  });
});

describe('Terms of Use and Privacy Policy acceptance', () => {
  it('records the server time, the method from the token and a history entry', async () => {
    const r = await acceptTerms(db.asFirestore(), user(), V, null, 'Chrome on Windows', 1_700_000_000_000);
    expect(r.recorded).toBe(true);
    expect(profileOf('n1').consent).toEqual({ ...V, acceptedAt: 1_700_000_000_000, method: 'google' });
    const hist = entries('users/n1/consents/');
    expect(hist).toHaveLength(1);
    expect(hist[0][1]).toMatchObject({ userId: 'n1', termsAccepted: true, privacyAccepted: true, method: 'google' });
    expect(JSON.stringify(entries('users/n1/securityEvents/'))).toContain('terms_accepted');
  });

  it('accepting again with the same versions changes nothing', async () => {
    const first = await acceptTerms(db.asFirestore(), user(), V, null, 'x');
    const again = await acceptTerms(db.asFirestore(), user(), V, first.consent, 'x');
    expect(again.recorded).toBe(false);
    expect(entries('users/n1/consents/')).toHaveLength(1);
  });

  it('only the current versions can be accepted; an update asks again and keeps the history', async () => {
    await expect(acceptTerms(db.asFirestore(), user(), { termsVersion: '0.9', privacyVersion: PRIVACY_VERSION }, null, 'x')).rejects.toMatchObject({ code: 'terms_outdated' });
    const old = { termsVersion: '0.9', privacyVersion: '0.9', acceptedAt: 1, method: 'google' as const };
    db.docs.set('users/n1/consents/0001', { ...old });
    const r = await acceptTerms(db.asFirestore(), user(), V, old, 'x');
    expect(r.recorded).toBe(true);
    expect(entries('users/n1/consents/')).toHaveLength(2);
  });

  it('moving from version 1.3 to 1.4: 1.3 is refused, accepting 1.4 adds to the history and keeps the 1.2 and 1.3 records', async () => {
    expect([TERMS_VERSION, PRIVACY_VERSION]).toEqual(['1.4', '1.4']);
    const v13 = { termsVersion: '1.3', privacyVersion: '1.3', acceptedAt: 1, method: 'google' as const };
    await expect(acceptTerms(db.asFirestore(), user(), { termsVersion: '1.3', privacyVersion: '1.3' }, null, 'x')).rejects.toMatchObject({ code: 'terms_outdated' });
    db.docs.set('users/n1/consents/v12', { ...v13, termsVersion: '1.2', privacyVersion: '1.2', termsAccepted: true, privacyAccepted: true });
    db.docs.set('users/n1/consents/v13', { ...v13, termsAccepted: true, privacyAccepted: true });
    const r = await acceptTerms(db.asFirestore(), user(), V, v13, 'x', 2_000);
    expect(r.recorded).toBe(true);
    expect(profileOf('n1').consent).toMatchObject({ termsVersion: '1.4', privacyVersion: '1.4', acceptedAt: 2_000 });
    const hist = entries('users/n1/consents/').map(([, d]) => (d as { termsVersion: string }).termsVersion).sort();
    expect(hist).toEqual(['1.2', '1.3', '1.4']);
  });

  it('email/password sign-ups are recorded as such', async () => {
    await acceptTerms(db.asFirestore(), user({ uid: 'p1', provider: 'password' }), V, null, 'x');
    expect(profileOf('p1').consent).toMatchObject({ method: 'email_password' });
  });

  it('a request cannot be submitted before accepting', async () => {
    await expect(submitRequest(db.asFirestore(), user(), { fullName: 'New Person', phone: '0241234567' })).rejects.toMatchObject({ code: 'consent_required' });
  });

  it('accepting does not change approval: pending stays pending, rejected stays rejected', async () => {
    db.docs.set('users/n1', { email: 'new@example.com', accessStatus: 'rejected' });
    await acceptTerms(db.asFirestore(), user(), V, null, 'x');
    expect(decideAccess(user(), profileOf('n1') as never, null, OWNER).state).toBe('rejected');

    const n2 = user({ uid: 'n2', email: 'n2@example.com' });
    db.docs.set('users/n2', { email: 'n2@example.com', accessStatus: 'pending' });
    await acceptTerms(db.asFirestore(), n2, V, null, 'x');
    expect(decideAccess(n2, profileOf('n2') as never, null, OWNER, { status: 'pending' }).state).toBe('pending');
    // an administrator still approves as usual
    db.docs.set('accessRequests/n2', { status: 'pending', history: [], email: 'n2@example.com' });
    await setAccess(db.asFirestore(), { uid: 'a', email: 'owner@example.com' }, { uid: 'n2', email: 'n2@example.com' }, 'approve');
    expect(decideAccess(n2, profileOf('n2') as never, null, OWNER).state).toBe('approved');
  });
});
