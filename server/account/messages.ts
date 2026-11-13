/**
 * Admin › Messages: administrators send a text message and/or an email to
 * users, and keep reusable templates.
 *
 * - Recipients: active accounts only. Emails go to verified addresses only and
 *   texts to verified numbers only, and both respect the person's
 *   "Announcements" switch. Nobody is messaged twice in one send.
 * - Cost control: texts count against SMS_MESSAGE_DAILY_CAP (app-wide, per
 *   day); emails go through the email service (its per-address and daily
 *   limits keep codes working). At most MAX_RECIPIENTS people per send.
 * - Each send is recorded in adminMessages/{id} (counts only, no addresses)
 *   and in the administrator log.
 * - "{name}" in a message is replaced with the person's first name.
 */
import { randomUUID } from 'node:crypto';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { prefsFrom, sendEmail, type EmailDeps } from '../email/service.js';
import type { SmsProvider } from '../sms/provider.js';
import { sendNoticeSms, type SmsNoticeResult } from './notices.js';

export const MAX_RECIPIENTS = 300;
export const MAX_TEMPLATES = 40;
/** two SMS segments */
export const SMS_MAX = 306;
export const TEMPLATES_PATH = 'config/messageTemplates';

export type Audience = 'all' | 'approved' | 'pending' | 'selected' | 'me';
/**
 * announcement: news for a group; follows the "announcements" switch.
 * support: a reply to one person about their own account or problem; follows their support
 * email and support text switches instead, and also reaches a suspended account.
 */
export type MessagePurpose = 'announcement' | 'support';

export interface MessageTemplate {
  id: string;
  name: string;
  /** email subject and body (empty = template has no email part) */
  subject: string;
  body: string;
  /** text message (empty = template has no SMS part) */
  sms: string;
  updatedAt: number;
  updatedBy: string;
}

export interface MessageCandidate {
  uid: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  /** verified number only */
  phone: string | null;
  status: 'active' | 'suspended' | 'deleted';
  accessStatus: 'pending' | 'approved' | 'rejected';
  prefs: unknown;
}

export interface MessageInput {
  audience: Audience;
  uids?: string[];
  purpose?: MessagePurpose;
  email: { subject: string; body: string } | null;
  sms: string | null;
}

export interface MessageRecord {
  id: string;
  at: number;
  by: string;
  audience: Audience;
  purpose?: MessagePurpose;
  subject: string | null;
  smsText: string | null;
  bodyPreview: string | null;
  recipients: number;
  status: 'sending' | 'done';
  email: { sent: number; skipped: number; failed: number };
  sms: { sent: number; skipped: number; failed: number; limited: number };
  finishedAt?: number;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0]?.slice(0, 40) || 'there';
export const personalise = (text: string, name: string) => text.replace(/\{name\}/gi, firstName(name));

/** Atlas AI: prefix so people know who texted them. */
export function smsBody(text: string): string {
  const t = text.trim();
  return /^atlas ai\b/i.test(t) ? t : `Atlas AI: ${t}`;
}

export async function loadTemplates(db: Firestore): Promise<MessageTemplate[]> {
  const doc = await db.get<{ items?: MessageTemplate[] }>(TEMPLATES_PATH);
  return (doc?.data.items ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveTemplate(
  db: Firestore,
  t: { id?: string; name: string; subject: string; body: string; sms: string },
  by: string,
  now = Date.now(),
): Promise<MessageTemplate> {
  const name = t.name.trim().slice(0, 80);
  if (name.length < 2) throw new HttpError(400, 'bad_template', 'Give the template a name.');
  const subject = t.subject.trim().slice(0, 150);
  const body = t.body.trim().slice(0, 5000);
  const sms = t.sms.trim().slice(0, SMS_MAX);
  if (!sms && !(subject && body))
    throw new HttpError(400, 'bad_template', 'Add a text message, or an email subject and body.');
  if ((subject && !body) || (!subject && body))
    throw new HttpError(400, 'bad_template', 'An email needs both a subject and a message.');
  const items = await loadTemplates(db);
  const existing = t.id ? items.find((x) => x.id === t.id) : undefined;
  if (!existing && items.length >= MAX_TEMPLATES)
    throw new HttpError(400, 'too_many_templates', `You can keep up to ${MAX_TEMPLATES} templates.`);
  const saved: MessageTemplate = { id: existing?.id ?? randomUUID(), name, subject, body, sms, updatedAt: now, updatedBy: by };
  await db.set(TEMPLATES_PATH, { items: [...items.filter((x) => x.id !== saved.id), saved], updatedAt: now }, true);
  return saved;
}

export async function deleteTemplate(db: Firestore, id: string, now = Date.now()) {
  const items = await loadTemplates(db);
  await db.set(TEMPLATES_PATH, { items: items.filter((x) => x.id !== id), updatedAt: now }, true);
}

/** Who a send reaches, and over which channel. */
export function recipients(
  all: MessageCandidate[],
  audience: Audience,
  opts: { uids?: string[]; selfUid: string; purpose?: MessagePurpose },
): { emails: MessageCandidate[]; texts: MessageCandidate[]; total: number } {
  const wanted = new Set(opts.uids ?? []);
  const support = opts.purpose === 'support';
  const people = all.filter((c) => {
    if (audience === 'me') return c.uid === opts.selfUid;
    // a support reply may explain a suspension; deleted accounts are never contacted
    if (support ? c.status === 'deleted' : c.status !== 'active') return false;
    if (audience === 'approved') return c.accessStatus === 'approved';
    if (audience === 'pending') return c.accessStatus === 'pending';
    if (audience === 'selected') return wanted.has(c.uid);
    return true;
  });
  // A test to yourself ignores your own switches.
  const wantsEmail = (c: MessageCandidate) => audience === 'me' || (support ? prefsFrom(c.prefs).support : prefsFrom(c.prefs).announcements);
  const wantsText = (c: MessageCandidate) => audience === 'me' || (support ? prefsFrom(c.prefs).supportSms : prefsFrom(c.prefs).announcements);
  const emails = people.filter((c) => c.email && c.emailVerified && wantsEmail(c));
  const texts = people.filter((c) => c.phone && wantsText(c));
  return { emails, texts, total: people.length };
}

export function validateMessage(m: MessageInput) {
  if (!m.email && !m.sms) throw new HttpError(400, 'bad_message', 'Write a text message or an email.');
  if (m.email && (!m.email.subject.trim() || !m.email.body.trim()))
    throw new HttpError(400, 'bad_message', 'The email needs a subject and a message.');
  if (m.sms !== null && !m.sms.trim()) throw new HttpError(400, 'bad_message', 'The text message is empty.');
  if (m.sms && smsBody(m.sms).length > SMS_MAX + 10)
    throw new HttpError(400, 'bad_message', `Keep the text message under ${SMS_MAX} characters.`);
  if (m.audience === 'selected' && !m.uids?.length)
    throw new HttpError(400, 'bad_message', 'Choose at least one person.');
  if (m.purpose === 'support' && (m.audience !== 'selected' || m.uids?.length !== 1))
    throw new HttpError(400, 'bad_message', 'A support message goes to exactly one person.');
}

export interface SendDeps {
  db: Firestore;
  mail: EmailDeps | null;
  sms: SmsProvider | null;
  smsDailyCap: number;
  now?: () => number;
}

/** Create the record; the caller runs `deliver` after responding (waitUntil). */
export async function startMessage(
  db: Firestore,
  m: MessageInput,
  plan: { emails: MessageCandidate[]; texts: MessageCandidate[]; total: number },
  by: string,
  now = Date.now(),
): Promise<MessageRecord> {
  validateMessage(m);
  const people = new Set([...(m.email ? plan.emails : []), ...(m.sms ? plan.texts : [])].map((c) => c.uid));
  if (!people.size) throw new HttpError(400, 'no_recipients', 'Nobody in this group can receive this message.');
  if (people.size > MAX_RECIPIENTS)
    throw new HttpError(400, 'too_many_recipients', `One message can go to at most ${MAX_RECIPIENTS} people. Choose a smaller group.`);
  const rec: MessageRecord = {
    id: `${now}-${randomUUID().slice(0, 8)}`,
    at: now,
    by,
    audience: m.audience,
    purpose: m.purpose ?? 'announcement',
    subject: m.email?.subject.trim().slice(0, 150) ?? null,
    smsText: m.sms ? smsBody(m.sms) : null,
    bodyPreview: m.email ? m.email.body.trim().slice(0, 200) : null,
    recipients: people.size,
    status: 'sending',
    email: { sent: 0, skipped: 0, failed: 0 },
    sms: { sent: 0, skipped: 0, failed: 0, limited: 0 },
  };
  await db.set(`adminMessages/${rec.id}`, rec);
  return rec;
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function deliver(
  deps: SendDeps,
  rec: MessageRecord,
  m: MessageInput,
  plan: { emails: MessageCandidate[]; texts: MessageCandidate[] },
): Promise<MessageRecord> {
  const now = (deps.now ?? Date.now)();
  const out = { ...rec, email: { ...rec.email }, sms: { ...rec.sms } };
  if (m.email) {
    const email = m.email;
    await pool(plan.emails, 4, async (c) => {
      if (!deps.mail) {
        out.email.skipped++;
        return;
      }
      const r = await sendEmail(deps.mail, {
        type: 'admin_message',
        category: m.purpose === 'support' ? 'support' : 'announcements',
        to: c.email!,
        uid: c.uid,
        data: {
          name: c.name,
          message: { subject: personalise(email.subject.trim(), c.name), body: personalise(email.body.trim(), c.name) },
        },
        dedupeKey: `message|${rec.id}|${c.uid}`,
        dedupeMs: 24 * 3_600_000,
      }).catch(() => ({ sent: false as const, status: 'failed' as const }));
      if (r.sent) out.email.sent++;
      else if (r.status === 'failed') out.email.failed++;
      else out.email.skipped++;
    });
  }
  if (m.sms) {
    const text = m.sms;
    // Parallel sends all read the counter before any increment, so take the day's budget up
    // front and spend it locally; the per-text check still guards against other senders.
    let budget = await smsLeftToday(deps.db, deps.smsDailyCap, now);
    await pool(plan.texts, 3, async (c) => {
      if (deps.sms && c.phone && budget <= 0) {
        out.sms.limited++;
        return;
      }
      budget--;
      const r: SmsNoticeResult = await sendNoticeSms(deps.db, deps.sms, {
        uid: c.uid,
        phone: c.phone,
        text: smsBody(personalise(text, c.name)),
        purpose: 'message',
        counter: 'message',
        cap: deps.smsDailyCap,
        now,
      });
      if (r !== 'sent') budget++;
      if (r === 'sent') out.sms.sent++;
      else if (r === 'failed') out.sms.failed++;
      else if (r === 'limited') out.sms.limited++;
      else out.sms.skipped++;
    });
  }
  const done: MessageRecord = { ...out, status: 'done', finishedAt: (deps.now ?? Date.now)() };
  await deps.db.set(`adminMessages/${rec.id}`, done).catch(() => undefined);
  return done;
}

export async function recentMessages(db: Firestore): Promise<MessageRecord[]> {
  const rows = await db.list<MessageRecord>('adminMessages', { orderBy: 'at', direction: 'DESCENDING', limit: 20 }).catch(() => []);
  return rows.map((r) => r.data);
}

/** Texts still available today (for the confirmation before sending). */
export async function smsLeftToday(db: Firestore, cap: number, now = Date.now()): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  const stats = await db.get<Record<string, number>>(`smsStats/${day}`);
  return Math.max(0, cap - (stats?.data.message ?? 0));
}
