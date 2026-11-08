import { beforeEach, describe, expect, it } from 'vitest';
import { phoneKey } from '../server/auth/otp.js';
import { recordFailedLogin, resetPassword, startRecovery, verifyRecovery, type RecoveryDeps } from '../server/auth/recovery.js';
import { HttpError } from '../server/http.js';
import type { SmsProvider } from '../server/sms/provider.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

class FakeSms implements SmsProvider {
  name = 'fake';
  sent: { to: string; message: string }[] = [];
  async send(to: string, message: string) {
    this.sent.push({ to, message });
    return { id: 't' };
  }
  lastCode() {
    return /code is (\d{6})/.exec(this.sent.at(-1)!.message)![1];
  }
}

const SECRET = 's'.repeat(64);
const PHONE = '+233241234567';
let db: FakeDb;
let sms: FakeSms;
let accounts: FakeAccounts;
let now: number;
let deps: RecoveryDeps;

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return (err as HttpError).code;
  }
  return 'ok';
}

function eligibleUser(uid = 'u1', email = 'ama@example.com') {
  accounts.add({ uid, email, providers: ['password'], claims: { phoneVerified: true } });
  db.docs.set(`users/${uid}`, { phoneNumber: PHONE, phoneVerified: true, accountStatus: 'active' });
  db.docs.set(`phoneNumbers/${phoneKey(SECRET, PHONE)}`, { uid });
}

beforeEach(() => {
  db = new FakeDb();
  sms = new FakeSms();
  accounts = new FakeAccounts();
  now = Date.parse('2026-11-08T10:00:00Z');
  deps = { db: db.asFirestore(), sms, accounts, secret: SECRET, dailyCap: 200, now: () => now, decoyDelayMs: 0 };
});

describe('SMS password recovery', () => {
  it('sends a code to the verified number without returning the number', async () => {
    eligibleUser();
    const r = await startRecovery(deps, ' Ama@Example.com ', '1.1.1.1');
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe(PHONE);
    expect(r.phoneMasked).toBeNull();
    expect(r.recoveryId).toMatch(/^[a-f0-9]{48}$/);
    expect(r).toMatchObject({ expiresIn: 300, resendIn: 60 });
    // the code itself is never stored
    const stored = JSON.stringify(db.docs.get(`recovery/${r.recoveryId}`));
    expect(stored).not.toContain(sms.lastCode());
  });

  it('does not reveal whether an address has an account', async () => {
    eligibleUser();
    const real = await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    const unknown = await startRecovery(deps, 'nobody@example.com', '1.1.1.2');
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(real).sort());
    // no number at all (never a made-up one), exactly like a real request
    expect(unknown.phoneMasked).toBeNull();
    expect(real.phoneMasked).toBeNull();
    expect(sms.sent).toHaveLength(1);
    // a decoy request can never be verified
    expect(await code(verifyRecovery(deps, unknown.recoveryId, '123456'))).toBe('invalid_code');
  });

  it.each([
    ['Google-only account', () => accounts.add({ uid: 'g', email: 'g@example.com', providers: ['google.com'], claims: { phoneVerified: true } })],
    ['unverified phone', () => accounts.add({ uid: 'g', email: 'g@example.com', providers: ['password'], claims: {} })],
    ['disabled account', () => accounts.add({ uid: 'g', email: 'g@example.com', providers: ['password'], claims: { phoneVerified: true }, disabled: true })],
  ])('never texts a %s', async (_label, setup) => {
    setup();
    db.docs.set('users/g', { phoneNumber: PHONE, phoneVerified: true, accountStatus: 'active' });
    db.docs.set(`phoneNumbers/${phoneKey(SECRET, PHONE)}`, { uid: 'g' });
    await startRecovery(deps, 'g@example.com', '1.1.1.1');
    expect(sms.sent).toHaveLength(0);
  });

  it('never texts a number now owned by another account', async () => {
    eligibleUser();
    db.docs.set(`phoneNumbers/${phoneKey(SECRET, PHONE)}`, { uid: 'someone-else' });
    await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    expect(sms.sent).toHaveLength(0);
  });

  it('enforces the 60 second resend cooldown and hourly limit', async () => {
    eligibleUser();
    await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    expect(await code(startRecovery(deps, 'ama@example.com', '1.1.1.1'))).toBe('resend_cooldown');
    for (let i = 0; i < 4; i++) {
      now += 61_000;
      await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    }
    now += 61_000;
    expect(await code(startRecovery(deps, 'ama@example.com', '1.1.1.1'))).toBe('too_many_codes');
  });

  it('expires codes after 5 minutes', async () => {
    eligibleUser();
    const r = await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    now += 5 * 60_000 + 1;
    expect(await code(verifyRecovery(deps, r.recoveryId, sms.lastCode()))).toBe('expired');
  });

  it('locks after 5 wrong attempts', async () => {
    eligibleUser();
    const r = await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    const wrong = sms.lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect(await code(verifyRecovery(deps, r.recoveryId, wrong))).toBe('invalid_code');
    expect(await code(verifyRecovery(deps, r.recoveryId, wrong))).toBe('too_many_attempts');
    expect(await code(verifyRecovery(deps, r.recoveryId, sms.lastCode()))).toBe('no_code');
  });

  it('a newer request replaces the older one', async () => {
    eligibleUser();
    const first = await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    const firstCode = sms.lastCode();
    now += 61_000;
    await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    expect(await code(verifyRecovery(deps, first.recoveryId, firstCode))).toBe('invalid_code');
  });

  it('resets the password through the admin API, single use, and revokes sessions', async () => {
    eligibleUser();
    const r = await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    const { resetToken } = await verifyRecovery(deps, r.recoveryId, sms.lastCode());
    // codes are single use
    expect(await code(verifyRecovery(deps, r.recoveryId, sms.lastCode()))).toBe('no_code');
    expect(await code(resetPassword(deps, r.recoveryId, resetToken, 'short', 'test'))).toBe('weak_password');
    expect(await code(resetPassword(deps, r.recoveryId, 'wrong-token', 'newpass123', 'test'))).toBe('reset_invalid');
    await resetPassword(deps, r.recoveryId, resetToken, 'newpass123', 'test');
    expect(accounts.users.get('u1')!.password).toBe('newpass123');
    expect(accounts.updates.at(-1)!.change).toMatchObject({ password: 'newpass123', revokeSessions: true });
    expect(db.docs.get('users/u1')!.sessionsValidAfter).toBe(Math.floor(now / 1000));
    // no password is ever written to Firestore
    expect(JSON.stringify([...db.docs.values()])).not.toContain('newpass123');
    const events = [...db.docs.entries()].filter(([p]) => p.startsWith('users/u1/securityEvents/'));
    expect(events.map(([, e]) => e.type)).toContain('password_reset');
    // the token is consumed
    expect(await code(resetPassword(deps, r.recoveryId, resetToken, 'another123', 'test'))).toBe('reset_invalid');
  });

  it('reset tokens expire after 10 minutes', async () => {
    eligibleUser();
    const r = await startRecovery(deps, 'ama@example.com', '1.1.1.1');
    const { resetToken } = await verifyRecovery(deps, r.recoveryId, sms.lastCode());
    now += 10 * 60_000 + 1;
    expect(await code(resetPassword(deps, r.recoveryId, resetToken, 'newpass123', 'test'))).toBe('reset_expired');
  });

  it('records failed logins only for real accounts, rate limited', async () => {
    eligibleUser();
    await recordFailedLogin(deps, 'nobody@example.com', 'test');
    for (let i = 0; i < 12; i++) await recordFailedLogin(deps, 'ama@example.com', 'test');
    const events = [...db.docs.keys()].filter((p) => p.includes('/securityEvents/'));
    expect(events).toHaveLength(10);
    expect(events.every((p) => p.startsWith('users/u1/'))).toBe(true);
  });
});
