import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../server/auth.js';
import {
  deleteTemplate,
  deliver,
  loadTemplates,
  MAX_TEMPLATES,
  personalise,
  recentMessages,
  recipients,
  saveTemplate,
  smsBody,
  smsLeftToday,
  startMessage,
  validateMessage,
  type MessageCandidate,
  type MessageInput,
} from '../server/account/messages.js';
import { accessApprovedNotice, approvalSmsText, sendNoticeSms } from '../server/account/notices.js';
import { submitRequest } from '../server/account/requests.js';
import type { EmailMessage, EmailProvider } from '../server/email/provider.js';
import { render } from '../server/email/templates.js';
import type { SmsProvider } from '../server/sms/provider.js';
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
const NOW = Date.parse('2026-11-09T10:00:00Z');
let db: FakeDb;
let mail: FakeMail;
let sms: FakeSms;

const person = (o: Partial<MessageCandidate> & { uid: string }): MessageCandidate => ({
  name: 'Ama Mensah',
  email: `${o.uid}@example.com`,
  emailVerified: true,
  phone: '+233241234567',
  status: 'active',
  accessStatus: 'approved',
  prefs: undefined,
  ...o,
});

const mailDeps = () => ({
  db: db.asFirestore(),
  provider: mail,
  baseUrl: BASE,
  dailyCap: 100,
  now: () => NOW,
});

beforeEach(() => {
  db = new FakeDb();
  mail = new FakeMail();
  sms = new FakeSms();
});

describe('message helpers', () => {
  it('replaces {name} with the first name and prefixes texts', () => {
    expect(personalise('Hi {name}, {NAME}!', 'Ama Mensah')).toBe('Hi Ama, Ama!');
    expect(personalise('Hi {name}', '  ')).toBe('Hi there');
    expect(smsBody('maintenance tonight')).toBe('Atlas AI: maintenance tonight');
    expect(smsBody('Atlas AI: already prefixed')).toBe('Atlas AI: already prefixed');
  });

  it('validates the message', () => {
    const base: MessageInput = { audience: 'all', email: null, sms: null };
    expect(() => validateMessage(base)).toThrow(/text message or an email/);
    expect(() => validateMessage({ ...base, email: { subject: 'Hi', body: ' ' } })).toThrow(/subject and a message/);
    expect(() => validateMessage({ ...base, sms: '   ' })).toThrow(/empty/);
    expect(() => validateMessage({ ...base, sms: 'x'.repeat(400) })).toThrow(/under/);
    expect(() => validateMessage({ ...base, audience: 'selected', sms: 'Hi' })).toThrow(/at least one/);
    expect(() => validateMessage({ ...base, sms: 'Hi' })).not.toThrow();
  });
});

describe('recipients', () => {
  const all = [
    person({ uid: 'a', accessStatus: 'approved' }),
    person({ uid: 'b', accessStatus: 'pending', phone: null }),
    person({ uid: 'c', accessStatus: 'approved', emailVerified: false }),
    person({ uid: 'd', status: 'suspended' }),
    person({ uid: 'e', prefs: { announcements: false } }),
    person({ uid: 'admin', status: 'suspended', prefs: { announcements: false } }),
  ];

  it('reaches active people only, by verified channel, respecting announcements', () => {
    const r = recipients(all, 'all', { selfUid: 'admin' });
    expect(r.total).toBe(4);
    expect(r.emails.map((c) => c.uid)).toEqual(['a', 'b']);
    expect(r.texts.map((c) => c.uid)).toEqual(['a', 'c']);
  });

  it('filters by group', () => {
    expect(recipients(all, 'approved', { selfUid: 'x' }).total).toBe(3);
    expect(recipients(all, 'pending', { selfUid: 'x' }).emails.map((c) => c.uid)).toEqual(['b']);
    expect(recipients(all, 'selected', { selfUid: 'x', uids: ['c', 'd'] }).texts.map((c) => c.uid)).toEqual(['c']);
  });

  it('a test to yourself ignores your own switches', () => {
    const r = recipients(all, 'me', { selfUid: 'admin' });
    expect(r.total).toBe(1);
    expect(r.emails).toHaveLength(1);
    expect(r.texts).toHaveLength(1);
  });
});

describe('templates', () => {
  it('saves, updates, lists and deletes', async () => {
    const f = db.asFirestore();
    const t = await saveTemplate(f, { name: 'Maintenance', subject: '', body: '', sms: 'Down tonight' }, 'admin@x');
    await saveTemplate(f, { name: 'Another', subject: 'Hi', body: 'Body', sms: '' }, 'admin@x');
    await saveTemplate(f, { id: t.id, name: 'Maintenance 2', subject: '', body: '', sms: 'Down' }, 'admin@x');
    expect((await loadTemplates(f)).map((x) => x.name)).toEqual(['Another', 'Maintenance 2']);
    await deleteTemplate(f, t.id);
    expect((await loadTemplates(f)).map((x) => x.name)).toEqual(['Another']);
  });

  it('rejects empty or half-filled templates and enforces the limit', async () => {
    const f = db.asFirestore();
    await expect(saveTemplate(f, { name: 'X', subject: '', body: '', sms: 'Hi' }, 'a')).rejects.toMatchObject({ code: 'bad_template' });
    await expect(saveTemplate(f, { name: 'Empty', subject: '', body: '', sms: '' }, 'a')).rejects.toMatchObject({ code: 'bad_template' });
    await expect(saveTemplate(f, { name: 'Half', subject: 'Hi', body: '', sms: '' }, 'a')).rejects.toMatchObject({ code: 'bad_template' });
    for (let i = 0; i < MAX_TEMPLATES; i++) await saveTemplate(f, { name: `T${i}`, subject: '', body: '', sms: 'Hi' }, 'a');
    await expect(saveTemplate(f, { name: 'One more', subject: '', body: '', sms: 'Hi' }, 'a')).rejects.toMatchObject({ code: 'too_many_templates' });
  });
});

describe('sending', () => {
  const plan = () =>
    recipients(
      [
        person({ uid: 'a', name: 'Ama Mensah', phone: '+233241111111' }),
        person({ uid: 'b', name: 'Kojo Boateng', phone: '+233242222222' }),
      ],
      'all',
      { selfUid: 'x' },
    );
  const input: MessageInput = {
    audience: 'all',
    email: { subject: 'Hello {name}', body: 'First paragraph.\n\nSecond <b>para</b>.' },
    sms: 'Hi {name}, new features are live.',
  };

  it('records the send, emails and texts each person once, and counts the results', async () => {
    const f = db.asFirestore();
    const rec = await startMessage(f, input, plan(), 'admin@x', NOW);
    expect(rec).toMatchObject({ status: 'sending', recipients: 2 });
    const done = await deliver({ db: f, mail: mailDeps(), sms, smsDailyCap: 100, now: () => NOW }, rec, input, plan());
    expect(done).toMatchObject({ status: 'done', email: { sent: 2, failed: 0 }, sms: { sent: 2, failed: 0 } });
    expect(mail.sent.map((m) => m.subject).sort()).toEqual(['Hello Ama', 'Hello Kojo']);
    expect(mail.sent[0]!.html).toContain('Second &lt;b&gt;para&lt;/b&gt;.');
    expect(sms.sent.map((s) => s.text).sort()).toEqual([
      'Atlas AI: Hi Ama, new features are live.',
      'Atlas AI: Hi Kojo, new features are live.',
    ]);
    expect(db.docs.get(`adminMessages/${rec.id}`)).toMatchObject({ status: 'done' });
    expect(await smsLeftToday(f, 100, NOW)).toBe(98);
    expect((await recentMessages(f))[0]!.id).toBe(rec.id);
  });

  it('stops texting at the daily cap and reports failures', async () => {
    const f = db.asFirestore();
    db.docs.set('smsStats/2026-11-09', { message: 99 });
    const rec = await startMessage(f, { ...input, email: null }, plan(), 'admin@x', NOW);
    const done = await deliver({ db: f, mail: null, sms, smsDailyCap: 100, now: () => NOW }, rec, { ...input, email: null }, plan());
    expect(done.sms).toMatchObject({ sent: 1, limited: 1 });
    sms.fail = true;
    db.docs.set('smsStats/2026-11-09', { message: 0 });
    const again = await deliver({ db: f, mail: null, sms, smsDailyCap: 100, now: () => NOW }, rec, { ...input, email: null }, plan());
    expect(again.sms).toMatchObject({ sent: 0, failed: 2 });
  });

  it('refuses a send nobody can receive', async () => {
    const empty = recipients([person({ uid: 'a', phone: null })], 'all', { selfUid: 'x' });
    await expect(
      startMessage(db.asFirestore(), { audience: 'all', email: null, sms: 'Hi' }, empty, 'a', NOW),
    ).rejects.toMatchObject({ code: 'no_recipients' });
  });
});

describe('approval notice', () => {
  let accounts: FakeAccounts;
  beforeEach(() => {
    accounts = new FakeAccounts();
    accounts.add({ uid: 'u1', email: 'ama@example.com', displayName: 'Ama' });
  });
  const deps = () => ({
    db: db.asFirestore(),
    mail: mailDeps(),
    sms,
    accounts,
    baseUrl: BASE,
    smsDailyCap: 50,
    now: () => NOW,
  });

  it('emails and texts a verified number once', async () => {
    db.docs.set('users/u1', { displayName: 'Ama', phoneNumber: '+233241234567', phoneVerified: true });
    expect(await accessApprovedNotice(deps(), 'u1')).toEqual({ email: 'accepted', sms: 'sent' });
    expect(mail.sent[0]!.subject).toBe('Your Atlas AI account has been approved');
    expect(sms.sent[0]).toEqual({ to: '+233241234567', text: approvalSmsText(BASE) });
    expect(sms.sent[0]!.text).toContain('chatatlasai.vercel.app');
    // second approval the same day: email deduplicated
    await accessApprovedNotice(deps(), 'u1');
    expect(mail.sent).toHaveLength(1);
  });

  it('does not text an unverified number and never throws', async () => {
    db.docs.set('users/u1', { phoneNumber: '+233241234567', phoneVerified: false });
    expect((await accessApprovedNotice(deps(), 'u1')).sms).toBe('no_phone');
    expect(sms.sent).toHaveLength(0);
    sms.fail = true;
    db.docs.set('users/u1', { phoneNumber: '+233241234567', phoneVerified: true });
    expect((await accessApprovedNotice(deps(), 'u1')).sms).toBe('failed');
    expect(await accessApprovedNotice(deps(), 'missing')).toEqual({ email: 'skipped', sms: 'skipped' });
  });

  it('sendNoticeSms respects its counter cap', async () => {
    db.docs.set('smsStats/2026-11-09', { notify: 5 });
    const o = { uid: 'u1', phone: '+233241234567', text: 'x', purpose: 'approval' as const, counter: 'notify' as const, cap: 5, now: NOW };
    expect(await sendNoticeSms(db.asFirestore(), sms, o)).toBe('limited');
    expect(await sendNoticeSms(db.asFirestore(), null, o)).toBe('skipped');
  });

  it('admin message email renders paragraphs in the brand colours', () => {
    const r = render('admin_message', { name: 'Ama', message: { subject: 'News', body: 'One.\n\nTwo.' } }, BASE);
    expect(r.subject).toBe('News');
    expect(r.html).toMatch(/One\.[\s\S]*Two\./);
    expect(r.html.toLowerCase()).not.toMatch(/#(7c3aed|8b5cf6|a855f7|6d28d9)/);
  });
});

describe('access request after phone verification', () => {
  it('files a request for a password account with a verified phone but no verified email', async () => {
    const user: AuthUser = {
      uid: 'p1',
      email: 'kojo@example.com',
      emailVerified: false,
      provider: 'password',
      phoneVerified: true,
      authTime: 1,
      token: 't',
      name: null,
      picture: null,
    };
    db.docs.set('users/p1', {
      displayName: 'Kojo',
      phoneNumber: '+233201234567',
      phoneVerified: true,
      consent: { termsVersion: '1.4', privacyVersion: '1.4', acceptedAt: 1, method: 'password' },
    });
    const r = await submitRequest(db.asFirestore(), user, { fullName: 'Kojo Boateng' });
    expect(r.request).toMatchObject({ phoneVerified: true });
    await expect(
      submitRequest(db.asFirestore(), { ...user, uid: 'p2', phoneVerified: false }, { fullName: 'X Y' }),
    ).rejects.toMatchObject({ code: 'email_unverified' });
  });
});
