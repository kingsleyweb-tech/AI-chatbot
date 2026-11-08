import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, otpStatus, phoneKey, sendCode, smsText, verifyCode, type OtpDeps } from '../server/auth/otp.js';
import { maskPhone, normalizePhone } from '../server/auth/phone.js';
import { HttpError } from '../server/http.js';
import type { SmsProvider } from '../server/sms/provider.js';
import { FakeDb } from './fakeDb.js';

class FakeSms implements SmsProvider {
  name = 'fake';
  sent: { to: string; message: string }[] = [];
  fail = false;
  async send(to: string, message: string) {
    if (this.fail) throw new HttpError(502, 'sms_failed', 'down');
    this.sent.push({ to, message });
    return { id: 't1' };
  }
  lastCode() {
    return /code is (\d{6})/.exec(this.sent.at(-1)!.message)![1];
  }
}

const SECRET = 'x'.repeat(64);
let db: FakeDb;
let sms: FakeSms;
let now: number;
let deps: OtpDeps;

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return (err as HttpError).code;
  }
  return 'ok';
}

beforeEach(() => {
  db = new FakeDb();
  sms = new FakeSms();
  now = Date.parse('2026-11-08T10:00:00Z');
  deps = { db: db.asFirestore(), sms, secret: SECRET, dailyCap: 200, now: () => now };
});

describe('phone normalisation', () => {
  it.each([
    ['024 123 4567', '+233241234567'],
    ['0241234567', '+233241234567'],
    ['233241234567', '+233241234567'],
    ['+233 24 123 4567', '+233241234567'],
    ['+2330241234567', '+233241234567'],
    ['00233551234567', '+233551234567'],
    ['(059) 123-4567', '+233591234567'],
    ['241234567', '+233241234567'],
  ])('%s -> %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164 });
  });

  it('rejects other countries, landlines, bad lengths and junk', () => {
    expect(normalizePhone('+2348031234567')).toEqual({ ok: false, reason: 'country' });
    expect(normalizePhone('0301234567')).toEqual({ ok: false, reason: 'format' }); // landline prefix
    expect(normalizePhone('02412345')).toEqual({ ok: false, reason: 'format' });
    expect(normalizePhone('024-abc-4567')).toEqual({ ok: false, reason: 'format' });
    expect(normalizePhone('')).toEqual({ ok: false, reason: 'format' });
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('+233241234567')).toBe('+233 •• ••• 4567');
  });
});

describe('sending codes', () => {
  it('texts a 6-digit code and stores only a hash', async () => {
    const r = await sendCode(deps, 'u1', '0241234567');
    expect(r).toEqual({ phoneMasked: '+233 •• ••• 4567', phoneDisplay: '+233 24 123 4567', expiresIn: 300, resendIn: 60, route: 'sms', codeLength: 6, delivery: 'pending' });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].to).toBe('+233241234567');
    const c = sms.lastCode();
    expect(sms.sent[0].message).toBe(smsText(c));
    const stored = JSON.stringify(db.docs.get('otp/u1'));
    expect(stored).not.toContain(`"${c}"`);
    expect(db.docs.get('otp/u1')!.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enforces the 60 s resend cooldown', async () => {
    await sendCode(deps, 'u1', '0241234567');
    now += 30_000;
    await expect(sendCode(deps, 'u1', '0241234567')).rejects.toMatchObject({ code: 'resend_cooldown', details: { retryAfter: 30 } });
    now += 31_000;
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('ok');
  });

  it('limits codes per hour and per day, per account and per phone', async () => {
    for (let i = 0; i < 3; i++) {
      await sendCode(deps, 'u1', '0241234567');
      now += 61_000;
    }
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('too_many_codes'); // 3 per hour
    // a different account cannot keep texting the same number
    expect(await code(sendCode(deps, 'u2', '0241234567'))).toBe('too_many_codes');
    for (let h = 0; h < 2; h++) {
      now += 3_600_000;
      for (let i = 0; i < 3; i++) {
        await sendCode(deps, 'u1', '0241234567');
        now += 61_000;
      }
    }
    now += 3_600_000;
    await sendCode(deps, 'u1', '0241234567'); // 10th today
    now += 3_600_000;
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('too_many_codes'); // 10 per day
    now += 24 * 3_600_000;
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('ok');
  });

  it('stops at the app-wide daily cap', async () => {
    deps.dailyCap = 2;
    await sendCode(deps, 'a', '0241234567');
    await sendCode(deps, 'b', '0551234567');
    expect(await code(sendCode(deps, 'c', '0201234567'))).toBe('sms_daily_cap');
    expect(sms.sent).toHaveLength(2);
  });

  it('rejects invalid and foreign numbers without texting', async () => {
    expect(await code(sendCode(deps, 'u1', '12345'))).toBe('invalid_phone');
    expect(await code(sendCode(deps, 'u1', '+447700900123'))).toBe('unsupported_country');
    expect(sms.sent).toHaveLength(0);
  });

  it('refuses a number already verified by another account', async () => {
    db.docs.set(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`, { uid: 'someone-else' });
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('phone_in_use');
    expect(sms.sent).toHaveLength(0);
  });

  it('a failed delivery leaves no usable code and allows an immediate retry', async () => {
    sms.fail = true;
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('sms_failed');
    expect(db.docs.get('otp/u1')!.codeHash).toBeNull();
    sms.fail = false;
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('ok');
  });
});

describe('verifying codes', () => {
  it('accepts the right code once and binds the phone to the account', async () => {
    await sendCode(deps, 'u1', '0241234567');
    const c = sms.lastCode();
    expect(await verifyCode(deps, 'u1', c)).toEqual({ phone: '+233241234567' });
    expect(db.docs.get(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`)!.uid).toBe('u1');
    expect(await code(verifyCode(deps, 'u1', c))).toBe('no_code'); // single use
  });

  it('expires after 5 minutes', async () => {
    await sendCode(deps, 'u1', '0241234567');
    now += 5 * 60_000 + 1;
    expect(await code(verifyCode(deps, 'u1', sms.lastCode()))).toBe('expired');
  });

  it('invalidates the code after 5 wrong attempts', async () => {
    await sendCode(deps, 'u1', '0241234567');
    const c = sms.lastCode();
    const wrong = c === '000000' ? '111111' : '000000';
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await expect(verifyCode(deps, 'u1', wrong)).rejects.toMatchObject({ code: 'invalid_code', details: { attemptsLeft: MAX_ATTEMPTS - i } });
    }
    expect(await code(verifyCode(deps, 'u1', wrong))).toBe('too_many_attempts');
    expect(await code(verifyCode(deps, 'u1', c))).toBe('no_code'); // even the right code is dead now
  });

  it('counts parallel guesses: concurrent attempts conflict instead of skipping the counter', async () => {
    await sendCode(deps, 'u1', '0241234567');
    const c = sms.lastCode();
    const wrong = c === '000000' ? '111111' : '000000';
    const results = await Promise.all(Array.from({ length: 5 }, () => code(verifyCode(deps, 'u1', wrong))));
    const counted = results.filter((r) => r === 'invalid_code').length;
    expect(counted + results.filter((r) => r === 'conflict').length).toBe(5);
    expect(db.docs.get('otp/u1')!.attempts).toBe(counted);
  });

  it('a code is bound to the account it was sent for', async () => {
    await sendCode(deps, 'u1', '0241234567');
    now += 61_000;
    expect(await code(verifyCode(deps, 'u2', sms.lastCode()))).toBe('no_code');
  });

  it('rejects malformed input without using an attempt', async () => {
    await sendCode(deps, 'u1', '0241234567');
    expect(await code(verifyCode(deps, 'u1', '12ab56'))).toBe('bad_code');
    expect(db.docs.get('otp/u1')!.attempts).toBe(0);
  });

  it('changing number releases the old one', async () => {
    await sendCode(deps, 'u1', '0241234567');
    await verifyCode(deps, 'u1', sms.lastCode());
    now += 61_000;
    await sendCode(deps, 'u1', '0551234567');
    await verifyCode(deps, 'u1', sms.lastCode());
    expect(db.docs.has(`phoneNumbers/${phoneKey(SECRET, '+233241234567')}`)).toBe(false);
    expect(db.docs.get(`phoneNumbers/${phoneKey(SECRET, '+233551234567')}`)!.uid).toBe('u1');
  });

  it('status never exposes the code', async () => {
    await sendCode(deps, 'u1', '0241234567');
    now += 20_000;
    const s = await otpStatus(deps, 'u1');
    expect(s).toEqual({
      pending: true,
      phoneMasked: '+233 •• ••• 4567',
      phoneDisplay: '+233 24 123 4567',
      route: 'sms',
      codeLength: 6,
      expiresIn: 280,
      resendIn: 40,
      attemptsLeft: 5,
      delivery: { state: 'pending', error: null },
    });
    expect(JSON.stringify(s)).not.toContain(sms.lastCode());
  });
});
