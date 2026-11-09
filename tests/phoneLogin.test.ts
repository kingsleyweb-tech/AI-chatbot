import { beforeEach, describe, expect, it } from 'vitest';
import { phoneKey } from '../server/auth/otp.js';
import { PHONE_LOGIN_PER_PHONE_HOUR, phoneLogin, type PhoneLoginDeps } from '../server/auth/phoneLogin.js';
import type { Firestore } from '../server/firestore.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

const SECRET = 's'.repeat(40);
const PHONE = '+233241234567';
const PASSWORD = 'correct1horse';

let db: FakeDb;
let accounts: FakeAccounts;
let wrong: string[];
let deps: PhoneLoginDeps;

function owner(uid = 'u1', email = 'ama@example.com') {
  accounts.add({ uid, email, providers: ['password'], claims: { phoneVerified: true } });
  db.docs.set(`users/${uid}`, { phoneNumber: PHONE, phoneVerified: true });
  db.docs.set(`phoneNumbers/${phoneKey(SECRET, PHONE)}`, { uid });
}

beforeEach(() => {
  db = new FakeDb();
  accounts = new FakeAccounts();
  wrong = [];
  deps = {
    db: db as unknown as Firestore,
    accounts,
    secret: SECRET,
    checkPassword: async (_email, pw) => (pw === PASSWORD ? 'ok' : 'wrong'),
    onWrongPassword: async (email) => {
      wrong.push(email);
    },
    minResponseMs: 0,
  };
});

describe('sign-in with a phone number', () => {
  it('returns the account email for the verified number and the right password, in any common format', async () => {
    owner();
    await expect(phoneLogin(deps, '024 123 4567', PASSWORD, 'ip')).resolves.toEqual({ email: 'ama@example.com' });
    await expect(phoneLogin(deps, '+233 24 123 4567', PASSWORD, 'ip')).resolves.toEqual({ email: 'ama@example.com' });
  });

  it('a wrong password gets the generic answer and counts towards the failed sign-in alert', async () => {
    owner();
    await expect(phoneLogin(deps, PHONE, 'nope1234', 'ip')).rejects.toMatchObject({ status: 401, code: 'invalid_login' });
    expect(wrong).toEqual(['ama@example.com']);
  });

  it.each([
    ['unknown number', () => undefined],
    ['number not verified on the profile', () => {
      owner();
      db.docs.set('users/u1', { phoneNumber: PHONE, phoneVerified: false });
    }],
    ['profile now has a different number', () => {
      owner();
      db.docs.set('users/u1', { phoneNumber: '+233201112222', phoneVerified: true });
    }],
    ['Google-only account', () => {
      owner();
      accounts.users.get('u1')!.providers = ['google.com'];
    }],
    ['no phoneVerified claim', () => {
      owner();
      accounts.users.get('u1')!.claims = {};
    }],
  ])('%s: same answer as a wrong password, and no password check', async (_n, setup) => {
    setup();
    let checked = false;
    deps.checkPassword = async () => {
      checked = true;
      return 'ok';
    };
    const err = await phoneLogin(deps, PHONE, PASSWORD, 'ip').catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: 'invalid_login', message: 'Incorrect phone number or password.' });
    expect(checked).toBe(false);
  });

  it('rejects invalid and non-Ghana numbers before any lookup', async () => {
    await expect(phoneLogin(deps, '12', PASSWORD, 'ip')).rejects.toMatchObject({ code: 'invalid_phone' });
    await expect(phoneLogin(deps, '+44 7700 900123', PASSWORD, 'ip')).rejects.toMatchObject({ code: 'invalid_phone' });
  });

  it('limits attempts per number', async () => {
    owner();
    for (let i = 0; i < PHONE_LOGIN_PER_PHONE_HOUR; i++)
      await phoneLogin(deps, PHONE, 'bad12345', `ip${i}`).catch(() => undefined);
    await expect(phoneLogin(deps, PHONE, PASSWORD, 'fresh-ip')).rejects.toMatchObject({ status: 429, code: 'too_many_attempts' });
  });

  it('pads quick refusals so they take about as long as a password check', async () => {
    deps.minResponseMs = 120;
    const t = Date.now();
    await phoneLogin(deps, PHONE, PASSWORD, 'ip').catch(() => undefined);
    expect(Date.now() - t).toBeGreaterThanOrEqual(110);
  });
});
