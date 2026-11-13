import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAccessCache, decideAccess, requireVerifiedEmail } from '../server/access.js';
import {
  deleteRequest,
  ensureProfile,
  listRequests,
  requestStats,
  setAccess,
  submitRequest,
} from '../server/account/requests.js';
import { phoneKey } from '../server/auth/otp.js';
import { normalizeInternational } from '../server/auth/phone.js';
import type { AuthUser } from '../server/auth.js';
import { FakeDb } from './fakeDb.js';

const SECRET = 'k'.repeat(64);
const OWNER = ['owner@example.com'];
const admin = { uid: 'admin1', email: 'owner@example.com' };
let db: FakeDb;

const google = (o: Partial<AuthUser> = {}): AuthUser => ({
  uid: 'g1',
  email: 'ama@example.com',
  emailVerified: true,
  provider: 'google.com',
  phoneVerified: false,
  authTime: 1,
  token: 't',
  name: 'Ama Mensah',
  picture: null,
  ...o,
});
const password = (o: Partial<AuthUser> = {}): AuthUser =>
  google({
    uid: 'p1',
    email: 'kojo@example.com',
    provider: 'password',
    phoneVerified: true,
    name: null,
    ...o,
  });

/** current Terms/Privacy accepted (server/shared/legal.ts) */
const C = {
  consent: { termsVersion: '1.5', privacyVersion: '1.5', acceptedAt: 1, method: 'google' as const },
};
const consented = (uid: string) =>
  db.docs.set(`users/${uid}`, { ...(db.docs.get(`users/${uid}`) ?? {}), ...C });

beforeEach(() => {
  process.env.OTP_HMAC_SECRET = SECRET;
  process.env.ADMIN_EMAILS = OWNER[0];
  db = new FakeDb();
  clearAccessCache();
});
afterEach(() => {
  delete process.env.OTP_HMAC_SECRET;
  delete process.env.ADMIN_EMAILS;
});

describe('decideAccess', () => {
  const cfg = { allowedEmails: ['legacy@example.com'], adminEmails: ['admin2@example.com'] };
  it('checks phone, then email, then account status, then approval', () => {
    expect(decideAccess(password({ phoneVerified: false }), undefined, cfg, OWNER).state).toBe(
      'phone',
    );
    expect(decideAccess(google({ emailVerified: false }), undefined, cfg, OWNER).state).toBe(
      'unverified',
    );
    expect(
      decideAccess(google(), { accountStatus: 'suspended', accessStatus: 'approved' }, cfg, OWNER)
        .state,
    ).toBe('suspended');
    expect(decideAccess(google(), { accountStatus: 'deleted' }, cfg, OWNER).state).toBe('deleted');
  });
  it('phone verification alone never grants access', () => {
    expect(decideAccess(password(), { ...C, accessStatus: 'pending' }, cfg, OWNER).state).toBe(
      'request',
    );
  });
  it('admins, approved profiles and the legacy allowlist are approved', () => {
    expect(decideAccess(google({ email: 'owner@example.com' }), C, null, OWNER)).toEqual({
      state: 'approved',
      admin: true,
    });
    expect(decideAccess(google({ email: 'admin2@example.com' }), C, cfg, OWNER)).toEqual({
      state: 'approved',
      admin: true,
    });
    expect(decideAccess(google(), { ...C, accessStatus: 'approved' }, cfg, OWNER).state).toBe(
      'approved',
    );
    expect(decideAccess(google({ email: 'legacy@example.com' }), C, cfg, OWNER).state).toBe(
      'approved',
    );
  });
  it('a verified phone lets an approved account in before its email is verified', () => {
    expect(
      decideAccess(
        password({ emailVerified: false }),
        { ...C, accessStatus: 'approved' },
        cfg,
        OWNER,
      ),
    ).toEqual({ state: 'approved', admin: false });
    // neither the email nor a phone verified: still "unverified"
    expect(
      decideAccess(google({ emailVerified: false }), { ...C, accessStatus: 'approved' }, cfg, OWNER)
        .state,
    ).toBe('unverified');
  });
  it('an unverified address never matches the administrator list or the allowlist', () => {
    expect(
      decideAccess(password({ email: 'owner@example.com', emailVerified: false }), C, null, OWNER),
    ).toEqual({ state: 'request', admin: false });
    expect(
      decideAccess(password({ email: 'admin2@example.com', emailVerified: false }), C, cfg, OWNER)
        .admin,
    ).toBe(false);
    expect(
      decideAccess(password({ email: 'legacy@example.com', emailVerified: false }), C, cfg, OWNER)
        .state,
    ).toBe('request');
  });
  it('requireVerifiedEmail refuses an unverified address', () => {
    expect(() => requireVerifiedEmail({ emailVerified: false })).toThrow(/Verify your email/);
    expect(() => requireVerifiedEmail({ emailVerified: true })).not.toThrow();
  });
  it('rejection overrides the legacy allowlist', () => {
    expect(
      decideAccess(
        google({ email: 'legacy@example.com' }),
        { ...C, accessStatus: 'rejected' },
        cfg,
        OWNER,
      ).state,
    ).toBe('rejected');
  });
  it('reports pending and missing requests', () => {
    expect(
      decideAccess(google(), { ...C, accessStatus: 'pending' }, cfg, OWNER, { status: 'pending' })
        .state,
    ).toBe('pending');
    expect(decideAccess(google(), { ...C, accessStatus: 'pending' }, cfg, OWNER, null).state).toBe(
      'request',
    );
  });
  it('asks for the current Terms of Use and Privacy Policy before approval, after account status', () => {
    expect(decideAccess(google(), { accessStatus: 'approved' }, cfg, OWNER).state).toBe('consent');
    expect(decideAccess(google({ email: 'owner@example.com' }), undefined, null, OWNER).state).toBe(
      'consent',
    );
    expect(
      decideAccess(
        google(),
        { accessStatus: 'approved', consent: { termsVersion: '0.9', privacyVersion: '1.3' } },
        cfg,
        OWNER,
      ).state,
    ).toBe('consent');
    // an account that accepted an earlier version (1.1 or 1.2) must accept 1.3 before continuing
    for (const v of ['1.1', '1.2'])
      expect(
        decideAccess(
          google(),
          {
            accessStatus: 'approved',
            consent: { termsVersion: v, privacyVersion: v, acceptedAt: 1, method: 'google' },
          },
          cfg,
          OWNER,
        ).state,
      ).toBe('consent');
    expect(decideAccess(google(), { accessStatus: 'approved', ...C }, cfg, OWNER).state).toBe(
      'approved',
    );
    // consent never lifts a suspension or a rejection
    expect(decideAccess(google(), { accountStatus: 'suspended' }, cfg, OWNER).state).toBe(
      'suspended',
    );
    expect(decideAccess(google(), { ...C, accessStatus: 'rejected' }, cfg, OWNER).state).toBe(
      'rejected',
    );
    expect(
      decideAccess(google(), { accessStatus: 'approved' }, cfg, OWNER, null, {
        ignoreConsent: true,
      }).state,
    ).toBe('approved');
  });
});

describe('international phone numbers', () => {
  it('normalises Ghana and other countries to E.164', () => {
    expect(normalizeInternational('024 123 4567', '+233')).toEqual({
      ok: true,
      e164: '+233241234567',
    });
    expect(normalizeInternational('+44 7700 900123')).toEqual({ ok: true, e164: '+447700900123' });
    expect(normalizeInternational('0803 123 4567', '+234')).toEqual({
      ok: true,
      e164: '+2348031234567',
    });
    expect(normalizeInternational('0044 7700 900123')).toEqual({ ok: true, e164: '+447700900123' });
  });
  it('rejects junk and invalid Ghana numbers', () => {
    expect(normalizeInternational('hello').ok).toBe(false);
    expect(normalizeInternational('123', '+1').ok).toBe(false);
    expect(normalizeInternational('+233 11 123 4567').ok).toBe(false);
  });
});

describe('profiles for every signed-in person', () => {
  it('creates a pending profile for a new, unapproved account', async () => {
    const p = await ensureProfile(db.asFirestore(), google(), null);
    expect(p).toMatchObject({
      uid: 'g1',
      email: 'ama@example.com',
      displayName: 'Ama Mensah',
      accessStatus: 'pending',
    });
    expect(db.docs.get('users/g1')).toMatchObject({
      accessStatus: 'pending',
      provider: 'google.com',
    });
  });
  it('migrates an existing allowlisted profile to approved without touching other fields', async () => {
    db.docs.set('users/g1', { displayName: 'Ama', settings: { theme: 'dark' } });
    await ensureProfile(db.asFirestore(), google(), { allowedEmails: ['ama@example.com'] });
    expect(db.docs.get('users/g1')).toEqual({
      displayName: 'Ama',
      settings: { theme: 'dark' },
      accessStatus: 'approved',
      email: 'ama@example.com',
    });
  });
  it('never downgrades an existing status', async () => {
    db.docs.set('users/g1', {
      email: 'ama@example.com',
      displayName: 'Ama',
      accessStatus: 'rejected',
    });
    await ensureProfile(db.asFirestore(), google(), { allowedEmails: ['ama@example.com'] });
    expect(db.docs.get('users/g1')!.accessStatus).toBe('rejected');
  });
});

describe('access requests', () => {
  beforeEach(() => {
    consented('g1');
    consented('p1');
  });
  it('stores a Google request with the email from the token and an unverified phone', async () => {
    const r = await submitRequest(db.asFirestore(), google(), {
      fullName: '  Ama   Mensah ',
      phone: '0241234567',
      dialCode: '+233',
      reason: 'Research',
    });
    expect(r).toMatchObject({ state: 'pending', created: true });
    expect(db.docs.get('accessRequests/g1')).toMatchObject({
      uid: 'g1',
      fullName: 'Ama Mensah',
      email: 'ama@example.com',
      phoneNumber: '+233241234567',
      phoneVerified: false,
      authProvider: 'google.com',
      status: 'pending',
      reason: 'Research',
    });
    expect(db.docs.get('users/g1')).toMatchObject({ accessStatus: 'pending' });
  });

  it('uses the verified phone of a password account', async () => {
    db.docs.set('users/p1', {
      ...C,
      email: 'kojo@example.com',
      displayName: 'Kojo',
      phoneNumber: '+233201234567',
      phoneVerified: true,
      accessStatus: 'pending',
    });
    await submitRequest(db.asFirestore(), password(), {
      fullName: 'Kojo Boateng',
      phone: '+447700900123',
    });
    expect(db.docs.get('accessRequests/p1')).toMatchObject({
      phoneNumber: '+233201234567',
      phoneVerified: true,
    });
  });

  it('refuses password accounts without a verified phone', async () => {
    await expect(
      submitRequest(db.asFirestore(), password({ phoneVerified: false }), { fullName: 'Kojo' }),
    ).rejects.toMatchObject({ code: 'phone_unverified' });
  });

  it('never creates a duplicate for the same account', async () => {
    await submitRequest(db.asFirestore(), google(), {
      fullName: 'Ama Mensah',
      phone: '0241234567',
    });
    const again = await submitRequest(db.asFirestore(), google(), {
      fullName: 'Someone Else',
      phone: '0201111111',
    });
    expect(again.created).toBe(false);
    expect(db.docs.get('accessRequests/g1')!.fullName).toBe('Ama Mensah');
    expect(db.under('accessRequests/')).toHaveLength(1);
  });

  it('blocks the same email or phone pending under another account, without revealing it', async () => {
    db.docs.set('accessRequests/other', {
      emailNorm: 'x@example.com',
      phoneNorm: '+233241234567',
      status: 'pending',
      email: 'x@example.com',
    });
    const err = await submitRequest(db.asFirestore(), google(), {
      fullName: 'Ama Mensah',
      phone: '0241234567',
    }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'duplicate_request' });
    expect(String(err.message)).not.toContain('x@example.com');
  });

  it('blocks a phone number verified on another account', async () => {
    db.docs.set(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`, { uid: 'someone' });
    await expect(
      submitRequest(db.asFirestore(), google(), { fullName: 'Ama Mensah', phone: '0241234567' }),
    ).rejects.toMatchObject({ code: 'phone_in_use' });
  });

  it('does not create a request for an already approved account', async () => {
    db.docs.set('config/access', { allowedEmails: ['ama@example.com'] });
    const r = await submitRequest(db.asFirestore(), google(), {
      fullName: 'Ama',
      phone: '0241234567',
    });
    expect(r).toMatchObject({ state: 'approved', created: false });
    expect(db.docs.has('accessRequests/g1')).toBe(false);
  });

  it('refuses suspended accounts', async () => {
    db.docs.set('users/g1', {
      accountStatus: 'suspended',
      email: 'ama@example.com',
      displayName: 'A',
      accessStatus: 'approved',
    });
    await expect(
      submitRequest(db.asFirestore(), google(), { fullName: 'Ama', phone: '0241234567' }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
  });
});

describe('administrator decisions', () => {
  beforeEach(async () => {
    consented('g1');
    await submitRequest(db.asFirestore(), google(), {
      fullName: 'Ama Mensah',
      phone: '0241234567',
    });
  });

  it('approval updates the same account and request, and is logged', async () => {
    await setAccess(db.asFirestore(), admin, { uid: 'g1', email: 'ama@example.com' }, 'approve');
    expect(db.docs.get('users/g1')).toMatchObject({
      accessStatus: 'approved',
      approvedBy: 'owner@example.com',
    });
    expect(db.docs.get('accessRequests/g1')).toMatchObject({
      status: 'approved',
      reviewedBy: 'owner@example.com',
    });
    expect(
      (db.docs.get('accessRequests/g1')!.history as { status: string }[]).map((h) => h.status),
    ).toEqual(['submitted', 'approved']);
    const logs = [...db.docs.entries()]
      .filter(([p]) => p.startsWith('adminLogs/'))
      .map(([, l]) => l.action);
    expect(logs).toEqual(['request_approved']);
    expect(decideAccess(google(), db.docs.get('users/g1') as never, null, OWNER).state).toBe(
      'approved',
    );
  });

  it('rejection blocks access and removes the email from the legacy allowlist', async () => {
    db.docs.set('config/access', {
      allowedEmails: ['ama@example.com', 'b@example.com'],
      adminEmails: [],
    });
    await setAccess(
      db.asFirestore(),
      admin,
      { uid: 'g1', email: 'ama@example.com' },
      'reject',
      'Not now',
    );
    expect(db.docs.get('users/g1')).toMatchObject({ accessStatus: 'rejected' });
    expect(db.docs.get('accessRequests/g1')).toMatchObject({
      status: 'rejected',
      reviewNote: 'Not now',
    });
    expect(db.docs.get('config/access')!.allowedEmails).toEqual(['b@example.com']);
    expect(
      decideAccess(google(), db.docs.get('users/g1'), db.docs.get('config/access') as never, OWNER)
        .state,
    ).toBe('rejected');
  });

  it('lists requests with statistics from the stored records', async () => {
    db.docs.set('accessRequests/x', {
      fullName: 'X',
      email: 'x@example.com',
      status: 'rejected',
      submittedAt: Date.now() - 30 * 86_400_000,
      history: [],
    });
    const rows = await listRequests(db.asFirestore());
    expect(rows.map((r) => r.uid)).toEqual(['g1', 'x']);
    expect(requestStats(rows)).toEqual({
      total: 2,
      pending: 1,
      approved: 0,
      rejected: 1,
      recent: 1,
    });
  });

  it('deleting a request keeps the account and allows a new request', async () => {
    await deleteRequest(db.asFirestore(), admin, 'g1');
    expect(db.docs.has('accessRequests/g1')).toBe(false);
    expect(db.docs.has('users/g1')).toBe(true);
    const r = await submitRequest(db.asFirestore(), google(), {
      fullName: 'Ama Mensah',
      phone: '0241234567',
    });
    expect(r.created).toBe(true);
  });
});
