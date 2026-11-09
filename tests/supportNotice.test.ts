import { beforeEach, describe, expect, it } from 'vitest';
import type { EmailMessage, EmailProvider } from '../server/email/provider.js';
import type { SmsProvider } from '../server/sms/provider.js';
import {
  supportSmsText,
  supportUpdateNotice,
  type SupportNoticeDeps,
} from '../server/support/notifyOut.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

class FakeMail implements EmailProvider {
  name = 'fake';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { messageId: `<m${this.sent.length}@test>`, attempts: 1 };
  }
}
class FakeSms implements SmsProvider {
  name = 'fake';
  sent: { to: string; text: string }[] = [];
  fail = false;
  async send(to: string, text: string) {
    if (this.fail) throw new Error('Vynfy said no');
    this.sent.push({ to, text });
    return { id: `t${this.sent.length}`, status: 'queued' };
  }
}

const BASE = 'https://chatatlasai.vercel.app';
let db: FakeDb;
let mail: FakeMail;
let sms: FakeSms;
let accounts: FakeAccounts;
let now: number;
let deps: SupportNoticeDeps;
const report = (
  o: Partial<{ ref: string; status: 'resolved' | 'under_review' | 'awaiting_user' }> = {},
) => ({
  ref: 'ATL-1001',
  uid: 'u1',
  title: 'Voice <mode> stops',
  status: 'resolved' as const,
  ...o,
});

beforeEach(() => {
  db = new FakeDb();
  mail = new FakeMail();
  sms = new FakeSms();
  accounts = new FakeAccounts();
  now = Date.parse('2026-11-09T10:00:00Z');
  accounts.add({ uid: 'u1', email: 'ama@example.com', displayName: 'Ama' });
  db.docs.set('users/u1', {
    displayName: 'Ama',
    phoneNumber: '+233241234567',
    phoneVerified: true,
  });
  deps = {
    db: db.asFirestore(),
    mail: { db: db.asFirestore(), provider: mail, baseUrl: BASE, dailyCap: 100, now: () => now },
    sms,
    accounts,
    baseUrl: BASE,
    smsDailyCap: 50,
    now: () => now,
  };
});

describe('support update notices', () => {
  it('a resolved report sends an email and a text without the report content', async () => {
    const r = await supportUpdateNotice(deps, report(), 'resolved', {
      reply: 'Fixed in the latest version.',
    });
    expect(r).toEqual({ email: 'accepted', sms: 'sent' });
    expect(mail.sent[0]!.subject).toBe('Your report ATL-1001 was resolved');
    expect(mail.sent[0]!.html).toContain('Voice &lt;mode&gt; stops');
    expect(mail.sent[0]!.html).toContain('Fixed in the latest version.');
    expect(mail.sent[0]!.html).toContain(`${BASE}/support/ATL-1001`);
    expect(sms.sent[0]).toEqual({
      to: '+233241234567',
      text: supportSmsText('resolved', 'ATL-1001', BASE),
    });
    expect(sms.sent[0]!.text).not.toContain('Voice');
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('smsLog/'))![1] as {
      purpose: string;
      accepted: boolean;
    };
    expect(log).toMatchObject({ purpose: 'support', accepted: true });
  });

  it('a reply or ordinary status change is email only', async () => {
    expect(
      await supportUpdateNotice(deps, report({ status: 'under_review' }), 'reply', {
        reply: 'Looking into it',
      }),
    ).toEqual({ email: 'accepted', sms: 'skipped' });
    expect(await supportUpdateNotice(deps, report({ status: 'under_review' }), 'status')).toEqual({
      email: 'accepted',
      sms: 'skipped',
    });
    expect(sms.sent).toHaveLength(0);
    expect(mail.sent.map((m) => m.subject)).toEqual([
      'New reply to your report ATL-1001',
      'Your report ATL-1001 is now under review',
    ]);
  });

  it('a request for information texts the user', async () => {
    const r = await supportUpdateNotice(deps, report({ status: 'awaiting_user' }), 'info_request', {
      reply: 'Which phone do you use?',
    });
    expect(r.sms).toBe('sent');
    expect(mail.sent[0]!.subject).toBe('We need more information about report ATL-1001');
  });

  it('respects the preferences', async () => {
    db.docs.set('users/u1', {
      ...(db.docs.get('users/u1') as object),
      emailPrefs: { support: false, supportSms: false },
    });
    expect(await supportUpdateNotice(deps, report(), 'resolved')).toEqual({
      email: 'opted_out',
      sms: 'opted_out',
    });
    expect(mail.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);
  });

  it('never emails an unverified address and never texts an unverified number', async () => {
    accounts.add({ uid: 'u1', email: 'ama@example.com', emailVerified: false });
    db.docs.set('users/u1', { phoneNumber: '+233241234567', phoneVerified: false });
    expect(await supportUpdateNotice(deps, report(), 'resolved')).toEqual({
      email: 'skipped',
      sms: 'no_phone',
    });
  });

  it('limits texts per report, per person and per day for the app', async () => {
    for (let i = 0; i < 3; i++) await supportUpdateNotice(deps, report(), 'resolved');
    expect(sms.sent).toHaveLength(2); // 2 per report per day
    for (let i = 2; i < 8; i++)
      await supportUpdateNotice(deps, report({ ref: `ATL-10${i}0` }), 'resolved');
    expect(sms.sent).toHaveLength(5); // 5 per person per day
    now += 86_400_000 + 1;
    deps.smsDailyCap = 0;
    expect((await supportUpdateNotice(deps, report({ ref: 'ATL-2000' }), 'resolved')).sms).toBe(
      'limited',
    );
  });

  it('an SMS failure is logged and never thrown', async () => {
    sms.fail = true;
    const r = await supportUpdateNotice(deps, report(), 'resolved');
    expect(r).toEqual({ email: 'accepted', sms: 'failed' });
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('smsLog/'))![1] as {
      accepted: boolean;
      delivery: string;
    };
    expect(log).toMatchObject({ accepted: false, delivery: 'failed' });
  });
});
