import { beforeEach, describe, expect, it } from 'vitest';
import { signInAlert } from '../server/account/alerts.js';
import {
  checkSignIn,
  clientInfo,
  locationOf,
  maskIp,
  parseAgent,
  type ClientInfo,
} from '../server/account/devices.js';
import {
  hasRecentStepUp,
  sendEmailCode,
  verifyEmailCode,
  type EmailCodeDeps,
} from '../server/auth/emailCode.js';
import {
  FAILED_LOGIN_ALERT,
  recordFailedLogin,
  resetPassword,
  startRecovery,
  verifyRecovery,
  type RecoveryDeps,
} from '../server/auth/recovery.js';
import { emailOverview, maskEmail, statusFromEvents } from '../server/email/log.js';
import {
  brevoProvider,
  EmailError,
  type EmailMessage,
  type EmailProvider,
} from '../server/email/provider.js';
import { sendEmail, type EmailDeps } from '../server/email/service.js';
import { EMAIL_TYPES, esc, render } from '../server/email/templates.js';
import { HttpError } from '../server/http.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

class FakeMail implements EmailProvider {
  name = 'fake';
  sent: EmailMessage[] = [];
  fail: EmailError | null = null;
  events?: EmailProvider['events'];
  async send(m: EmailMessage) {
    if (this.fail) throw this.fail;
    this.sent.push(m);
    return { messageId: `<m${this.sent.length}@test>`, attempts: 1 };
  }
  code() {
    return /(\d{6})/.exec(this.sent.at(-1)!.subject)![1]!;
  }
}

const SECRET = 's'.repeat(64);
const BASE = 'https://chatatlasai.vercel.app';
let db: FakeDb;
let mail: FakeMail;
let accounts: FakeAccounts;
let now: number;
let deps: EmailDeps;

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return (err as HttpError).code;
  }
  return 'ok';
}

const client = (over: Partial<ClientInfo> = {}): ClientInfo => ({
  deviceId: 'dev-aaaaaaaaaaaaaaaa',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  ip: '102.176.18.137',
  country: 'GH',
  region: 'AA',
  city: 'Accra',
  timeZone: 'Africa/Accra',
  ...over,
});

beforeEach(() => {
  db = new FakeDb();
  mail = new FakeMail();
  accounts = new FakeAccounts();
  now = Date.parse('2026-11-09T10:00:00Z');
  deps = { db: db.asFirestore(), provider: mail, baseUrl: BASE, dailyCap: 100, now: () => now };
});

describe('templates', () => {
  it('every template has the logo, the app name, a subject and a plain-text version, and no purple', () => {
    for (const t of EMAIL_TYPES) {
      const r = render(
        t,
        {
          name: 'Ama Owusu',
          code: '123456',
          at: now,
          device: {
            device: 'Phone',
            os: 'Android',
            browser: 'Chrome',
            ip: '1.2.x.x',
            location: 'Accra, Ghana',
          },
        },
        BASE,
      );
      expect(r.subject.length).toBeGreaterThan(5);
      expect(r.html).toContain(`${BASE}/pwa-192.png`);
      expect(r.html).toContain('Atlas AI');
      expect(r.text).toContain('Atlas AI');
      expect(r.html).not.toMatch(
        /purple|violet|indigo|#(?:7c3aed|8b5cf6|6366f1|a855f7|ec4899|db2777)/i,
      );
    }
  });

  it('escapes names and puts the code and the security button where they belong', () => {
    const r = render(
      'new_login',
      {
        name: '<script>x</script>',
        at: now,
        device: {
          device: 'Computer',
          os: 'Windows',
          browser: 'Chrome',
          ip: '102.176.x.x',
          location: 'Accra, Ghana',
        },
      },
      BASE,
    );
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('Review account security');
    expect(r.html).toContain(`${BASE}/settings/security`);
    expect(r.html).toContain('102.176.x.x');
    expect(render('verify_email', { code: '482910' }, BASE).text).toContain('482910');
    expect(esc(`"a'&`)).toBe('&quot;a&#39;&amp;');
  });
});

describe('Brevo provider', () => {
  function fakeFetch(
    responses: { status: number; body: unknown }[],
    calls: { url: string; init: RequestInit }[],
  ) {
    return (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
  }

  it('sends with the api-key header and returns the message id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const p = brevoProvider({
      apiKey: 'k',
      sender: { email: 'a@b.co', name: 'Atlas AI' },
      fetchImpl: fakeFetch([{ status: 201, body: { messageId: '<x@y>' } }], calls),
      sleep: async () => {},
    });
    const r = await p.send({
      to: { email: 'ama@example.com' },
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
    expect(r).toEqual({ messageId: '<x@y>', attempts: 1 });
    expect(calls[0]!.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((calls[0]!.init.headers as Record<string, string>)['api-key']).toBe('k');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      sender: { email: 'a@b.co', name: 'Atlas AI' },
      to: [{ email: 'ama@example.com' }],
      htmlContent: '<p>h</p>',
      textContent: 't',
    });
  });

  it('retries temporary failures and gives up on permanent ones', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const p = brevoProvider({
      apiKey: 'k',
      sender: { email: 'a@b.co', name: 'A' },
      fetchImpl: fakeFetch(
        [
          { status: 503, body: {} },
          { status: 429, body: { message: 'slow down' } },
          { status: 201, body: { messageId: 'id' } },
        ],
        calls,
      ),
      sleep: async () => {},
    });
    expect(
      (await p.send({ to: { email: 'x@y.co' }, subject: 's', html: 'h', text: 't' })).attempts,
    ).toBe(3);

    const ip = brevoProvider({
      apiKey: 'k',
      sender: { email: 'a@b.co', name: 'A' },
      fetchImpl: fakeFetch(
        [
          {
            status: 401,
            body: {
              message: 'We have detected you are using an unrecognised IP address 1.2.3.4',
              code: 'unauthorized',
            },
          },
        ],
        [],
      ),
      sleep: async () => {},
    });
    const err = await ip
      .send({ to: { email: 'x@y.co' }, subject: 's', html: 'h', text: 't' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err.code).toBe('ip_blocked');
    expect(err.attempts).toBe(1);
  });
});

describe('send service', () => {
  it('logs an accepted email without its content or the full address', async () => {
    const r = await sendEmail(deps, {
      type: 'verify_email',
      category: 'critical',
      to: 'Ama@Example.com',
      uid: 'u1',
      data: { code: '123456' },
    });
    expect(r).toMatchObject({ sent: true, status: 'accepted' });
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('emailLog/'))![1];
    expect(log).toMatchObject({
      type: 'verify_email',
      to: 'am•••@example.com',
      accepted: true,
      status: 'accepted',
      messageId: '<m1@test>',
    });
    expect(JSON.stringify(log)).not.toContain('123456');
    expect(maskEmail('kingsley@gmail.com')).toBe('ki•••@gmail.com');
  });

  it('a failure is logged and reported, never thrown', async () => {
    mail.fail = new EmailError('ip_blocked', 'unrecognised IP', 401);
    const r = await sendEmail(deps, {
      type: 'welcome',
      category: 'critical',
      to: 'ama@example.com',
    });
    expect(r).toMatchObject({ sent: false, status: 'failed', error: 'ip_blocked' });
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('emailLog/'))![1];
    expect(log).toMatchObject({
      accepted: false,
      status: 'failed',
      errorCode: 'ip_blocked',
      httpStatus: 401,
    });
  });

  it('follows preferences for optional emails only', async () => {
    db.docs.set('users/u1', { emailPrefs: { newLogin: false } });
    expect(
      (await sendEmail(deps, { type: 'new_login', category: 'newLogin', to: 'a@b.co', uid: 'u1' }))
        .status,
    ).toBe('opted_out');
    expect(
      (
        await sendEmail(deps, {
          type: 'password_changed',
          category: 'critical',
          to: 'a@b.co',
          uid: 'u1',
        })
      ).status,
    ).toBe('accepted');
    expect(
      (
        await sendEmail(deps, {
          type: 'security_change',
          category: 'security',
          to: 'a@b.co',
          uid: 'u1',
        })
      ).status,
    ).toBe('accepted');
  });

  it('de-duplicates by key, limits notifications per address and respects the daily cap', async () => {
    const a = await sendEmail(deps, {
      type: 'new_login',
      category: 'newLogin',
      to: 'a@b.co',
      dedupeKey: 'login|u1|1',
    });
    const b = await sendEmail(deps, {
      type: 'new_login',
      category: 'newLogin',
      to: 'a@b.co',
      dedupeKey: 'login|u1|1',
    });
    expect([a.status, b.status]).toEqual(['accepted', 'duplicate']);
    for (let i = 0; i < 5; i++)
      await sendEmail(deps, { type: 'security_change', category: 'security', to: 'a@b.co' });
    expect(
      (await sendEmail(deps, { type: 'security_change', category: 'security', to: 'a@b.co' }))
        .status,
    ).toBe('rate_limited');
    deps.dailyCap = mail.sent.length;
    expect(
      (await sendEmail(deps, { type: 'verify_email', category: 'critical', to: 'c@d.co' })).status,
    ).toBe('daily_cap');
  });

  it('without a provider nothing is sent and nothing breaks', async () => {
    expect(
      (
        await sendEmail(
          { ...deps, provider: null },
          { type: 'welcome', category: 'critical', to: 'a@b.co' },
        )
      ).status,
    ).toBe('unconfigured');
  });
});

describe('delivery status', () => {
  it('only provider events make an email delivered, bounced or blocked', async () => {
    expect(statusFromEvents([{ event: 'requests', date: null }]).status).toBeNull();
    expect(
      statusFromEvents([
        { event: 'delivered', date: null },
        { event: 'requests', date: null },
      ]).status,
    ).toBe('delivered');
    expect(
      statusFromEvents([{ event: 'hardBounces', date: null, reason: 'no such user' }]).status,
    ).toBe('bounced');
    expect(statusFromEvents([{ event: 'blocked', date: null }]).status).toBe('blocked');
    expect(statusFromEvents([{ event: 'deferred', date: null }]).status).toBe('deferred');
  });

  it('the overview refreshes accepted emails from the provider', async () => {
    mail.events = async () => [{ event: 'delivered', date: '2026-11-09T10:00:05Z' }];
    await sendEmail(deps, { type: 'welcome', category: 'critical', to: 'a@b.co' });
    const o = await emailOverview(db.asFirestore(), mail, now + 60_000);
    expect(o.totals).toMatchObject({ requests: 1, accepted: 1, delivered: 1, awaiting: 0 });
    expect(o.byType).toEqual({ welcome: 1 });
  });
});

describe('email codes for signed-in accounts', () => {
  let cd: EmailCodeDeps;
  beforeEach(() => {
    accounts.add({ uid: 'u1', email: 'ama@example.com', emailVerified: false, displayName: 'Ama' });
    cd = { db: db.asFirestore(), accounts, mail: deps, secret: SECRET, now: () => now };
  });

  it('verifies the email address with a single-use code that is never stored in plain text', async () => {
    const r = await sendEmailCode(cd, { uid: 'u1', email: 'ama@example.com' }, 'verify_email');
    expect(r).toMatchObject({ sentTo: 'am•••@example.com', expiresIn: 600, resendIn: 60 });
    expect(mail.sent[0]!.to.email).toBe('ama@example.com');
    const c = mail.code();
    expect(JSON.stringify([...db.docs.values()])).not.toContain(c);
    expect(await code(verifyEmailCode(cd, 'u1', 'verify_email', c))).toBe('ok');
    expect((await accounts.get('u1'))!.emailVerified).toBe(true);
    expect(await code(verifyEmailCode(cd, 'u1', 'verify_email', c))).toBe('no_code');
  });

  it('a new code replaces the old one; wrong codes lock after five tries; codes expire', async () => {
    await sendEmailCode(cd, { uid: 'u1', email: null }, 'verify_email');
    const first = mail.code();
    now += 61_000;
    await sendEmailCode(cd, { uid: 'u1', email: null }, 'verify_email');
    const second = mail.code();
    if (first !== second)
      expect(await code(verifyEmailCode(cd, 'u1', 'verify_email', first))).toBe('invalid_code');
    const wrong = second === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) await code(verifyEmailCode(cd, 'u1', 'verify_email', wrong));
    expect(await code(verifyEmailCode(cd, 'u1', 'verify_email', wrong))).toBe('too_many_attempts');
    expect(await code(verifyEmailCode(cd, 'u1', 'verify_email', second))).toBe('no_code');

    now += 61_000;
    await sendEmailCode(cd, { uid: 'u1', email: null }, 'verify_email');
    const third = mail.code();
    now += 11 * 60_000;
    expect(await code(verifyEmailCode(cd, 'u1', 'verify_email', third))).toBe('expired');
  });

  it('limits sends: 60 s apart and five per hour', async () => {
    await sendEmailCode(cd, { uid: 'u1', email: null }, 'sensitive');
    expect(await code(sendEmailCode(cd, { uid: 'u1', email: null }, 'sensitive'))).toBe(
      'resend_cooldown',
    );
    for (let i = 0; i < 4; i++) {
      now += 61_000;
      await sendEmailCode(cd, { uid: 'u1', email: null }, 'sensitive');
    }
    now += 61_000;
    expect(await code(sendEmailCode(cd, { uid: 'u1', email: null }, 'sensitive'))).toBe(
      'too_many_codes',
    );
  });

  it('a confirmed sensitive-action code grants a short step-up window', async () => {
    await sendEmailCode(cd, { uid: 'u1', email: null }, 'sensitive');
    expect(await hasRecentStepUp(db.asFirestore(), 'u1', now)).toBe(false);
    await verifyEmailCode(cd, 'u1', 'sensitive', mail.code());
    expect(await hasRecentStepUp(db.asFirestore(), 'u1', now + 60_000)).toBe(true);
    expect(await hasRecentStepUp(db.asFirestore(), 'u1', now + 11 * 60_000)).toBe(false);
  });

  it('a failed email voids the code and reports an error', async () => {
    mail.fail = new EmailError('unavailable', 'down', 503);
    expect(await code(sendEmailCode(cd, { uid: 'u1', email: null }, 'verify_email'))).toBe(
      'email_failed',
    );
  });
});

describe('devices and sign-in alerts', () => {
  it('reads device, system, browser, location and a partial IP', () => {
    expect(
      parseAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ device: 'Phone', os: 'iOS', browser: 'Safari' });
    expect(
      parseAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toEqual({ device: 'Phone', os: 'Android', browser: 'Chrome' });
    expect(maskIp('102.176.18.137')).toBe('102.176.x.x');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:…');
    expect(locationOf({ country: 'GH', region: null, city: 'Accra' })).toBe('Accra, Ghana');
    expect(locationOf({ country: null, region: null, city: 'Accra' })).toBeNull();
    const h = new Headers({
      'x-atlas-device': 'short',
      'x-vercel-ip-city': 'S%C3%A3o%20Paulo',
      'x-vercel-ip-country': 'BR',
      'x-atlas-tz': 'America/Sao_Paulo',
    });
    expect(clientInfo(h)).toMatchObject({
      deviceId: null,
      city: 'São Paulo',
      country: 'BR',
      timeZone: 'America/Sao_Paulo',
    });
  });

  it('every new sign-in session alerts once; the sign-in right after registering does not', async () => {
    const user = { uid: 'u1', email: 'ama@example.com', name: 'Ama' };
    expect(
      (
        (await signInAlert(deps, SECRET, user, 1000, client(), { newAccount: true })) as {
          error?: string;
        }
      ).error,
    ).toBe('new_account');
    expect(mail.sent).toHaveLength(0);
    const phone = client({
      deviceId: 'dev-bbbbbbbbbbbbbbbb',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36',
    });
    expect((await signInAlert(deps, SECRET, user, 2000, phone)).status).toBe('accepted');
    expect(mail.sent[0]!.subject).toBe('New sign-in to your Atlas AI account');
    expect(mail.sent[0]!.html).toContain('not seen before');
    expect(mail.sent[0]!.html).toContain('Android');
    expect(mail.sent[0]!.html).toContain('102.176.x.x');
    expect(mail.sent[0]!.html).not.toContain('102.176.18.137');
    // the same sign-in session reported twice (token refresh, second tab): no second email
    await signInAlert(deps, SECRET, user, 2000, phone);
    expect(mail.sent).toHaveLength(1);
    // a later sign-in on the same device: alerted, as a recognised device
    const again = await signInAlert(deps, SECRET, user, 3000, phone);
    expect(again.known).toBe(true);
    expect(again.status).toBe('accepted');
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1]!.html).toContain('used before');
  });

  it('the first sign-in of an existing account (not just registered) alerts', async () => {
    expect(
      (await signInAlert(deps, SECRET, { uid: 'u9', email: 'kofi@example.com' }, 1000, client()))
        .status,
    ).toBe('accepted');
  });

  it('sends no sign-in alert to an unverified address', async () => {
    const r = await signInAlert(
      deps,
      SECRET,
      { uid: 'u7', email: 'typo@example.com', emailVerified: false },
      1000,
      client(),
    );
    expect(r.sent).toBe(false);
    expect(mail.sent).toHaveLength(0);
  });

  it('a new device in a new country is reported as unusual', async () => {
    const user = { uid: 'u1', email: 'ama@example.com' };
    await signInAlert(deps, SECRET, user, 1000, client());
    await signInAlert(
      deps,
      SECRET,
      user,
      2000,
      client({ deviceId: 'dev-cccccccccccccccc', country: 'RU', city: 'Moscow' }),
    );
    expect(mail.sent.at(-1)!.subject).toBe('Unusual sign-in to your Atlas AI account');
    expect(mail.sent.at(-1)!.html).toContain('Moscow, Russia');
  });

  it('keeps at most 20 devices', async () => {
    for (let i = 0; i < 25; i++)
      await checkSignIn(
        db.asFirestore(),
        SECRET,
        'u1',
        client({ deviceId: `dev-${String(i).padStart(16, '0')}` }),
        now + i,
      );
    expect([...db.docs.keys()].filter((p) => p.startsWith('users/u1/devices/')).length).toBe(20);
  });
});

describe('password recovery by email', () => {
  let rd: RecoveryDeps;
  beforeEach(() => {
    rd = {
      db: db.asFirestore(),
      sms: null,
      mail: deps,
      accounts,
      secret: SECRET,
      dailyCap: 200,
      now: () => now,
      decoyDelayMs: 0,
      client: client(),
    };
  });

  it('emails a code to an email/password account and lets it reset the password, then confirms by email', async () => {
    accounts.add({
      uid: 'u1',
      email: 'ama@example.com',
      providers: ['password'],
      displayName: 'Ama',
    });
    const r = await startRecovery(rd, 'AMA@example.com', '1.1.1.1', 'email');
    expect(r).toMatchObject({ phoneMasked: null, expiresIn: 600, resendIn: 60 });
    expect(mail.sent[0]!.subject).toMatch(/password reset code/);
    const { resetToken } = await verifyRecovery(rd, r.recoveryId, mail.code());
    await resetPassword(rd, r.recoveryId, resetToken, 'newpass123', 'Chrome on Windows');
    expect((await accounts.get('u1'))!.passwordUpdatedAt).toBeTruthy();
    expect(mail.sent.at(-1)!.subject).toBe('Your Atlas AI password was changed');
  });

  it('never sends a reset code to an unverified address, with the same answer', async () => {
    accounts.add({
      uid: 'u2',
      email: 'typo@example.com',
      providers: ['password'],
      emailVerified: false,
    });
    const a = await startRecovery(rd, 'nobody@example.com', '1.1.1.1', 'email');
    const b = await startRecovery(rd, 'typo@example.com', '1.1.1.2', 'email');
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(mail.sent).toHaveLength(0);
  });

  it('unknown addresses and Google-only accounts get the same answer and no email', async () => {
    accounts.add({ uid: 'g1', email: 'google@example.com', providers: ['google.com'] });
    const a = await startRecovery(rd, 'nobody@example.com', '1.1.1.1', 'email');
    const b = await startRecovery(rd, 'google@example.com', '1.1.1.2', 'email');
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(mail.sent).toHaveLength(0);
    expect(await code(verifyRecovery(rd, a.recoveryId, '123456'))).toBe('invalid_code');
  });

  it('SMS recovery is unavailable without an SMS provider, but email still works', async () => {
    expect(await code(startRecovery(rd, 'ama@example.com', '1.1.1.1', 'sms'))).toBe(
      'recovery_unavailable',
    );
  });

  it('repeated failed sign-ins send one warning email', async () => {
    accounts.add({ uid: 'u1', email: 'ama@example.com', providers: ['password'] });
    for (let i = 0; i < FAILED_LOGIN_ALERT + 3; i++)
      await recordFailedLogin(rd, 'ama@example.com', 'Chrome on Windows');
    const warnings = mail.sent.filter((m) => m.subject.startsWith('Failed sign-in attempts'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.text).toContain(`${FAILED_LOGIN_ALERT} failed attempts`);
  });
});
