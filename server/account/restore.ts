/**
 * Getting a deleted account back during its 30-day recovery period.
 *
 * 1. "Cancel deletion" link: the deletion email (and the 7-day reminder) of an
 *    account its owner deleted from Settings carries a signed link. Opening it
 *    shows a page with one button; pressing it restores the account at once.
 *    The link is bound to that deletion (deletionStamp), so it stops working
 *    once the account is restored, deleted again or purged. Accounts deleted
 *    by an administrator never get one.
 * 2. Restore request: someone whose sign-in is refused can ask for the account
 *    back from the sign-in screen (address + optional reason). We email the
 *    address a link to confirm it is theirs; only confirmed requests reach the
 *    administrators, who approve (restore) or decline in Admin › Users. The
 *    reply never says whether an address has an account.
 * 3. Reminder: the daily job emails the owner 7 days before permanent deletion
 *    (self-deleted accounts only), once, with the cancel link.
 *
 * Links are HMAC-signed with OTP_HMAC_SECRET and checked with timingSafeEqual.
 * They are opened with a button press (POST), never by the GET itself, so mail
 * scanners that prefetch links cannot act on them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccountAdmin } from '../admin.js';
import { sendEmail, type EmailDeps } from '../email/service.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { CONTACT_EMAIL } from '../shared/legal.js';
import { recordSecurityEvent } from './events.js';
import { restoreAccount, type ProfileStatus } from './lifecycle.js';

export type RestoreLinkKind = 'cancel' | 'confirm';

export const CONFIRM_TTL_MS = 24 * 3_600_000;
export const REMIND_BEFORE_MS = 7 * 86_400_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface RestoreRequest {
  uid: string;
  email: string;
  reason: string | null;
  status: 'unconfirmed' | 'pending' | 'restored' | 'declined';
  /** request time; also binds the confirmation link */
  stamp: number;
  createdAt: number;
  confirmedAt?: number | null;
  decidedAt?: number | null;
  decidedBy?: string | null;
  purgeAfter: number | null;
  deletedBy: 'admin' | 'user' | null;
}

const sign = (secret: string, kind: RestoreLinkKind, uid: string, stamp: number) =>
  createHmac('sha256', secret).update(`restore|${kind}|${uid}|${stamp}`).digest('base64url');

/** Token for a restore link: "<uid>.<stamp>.<signature>". */
export function restoreToken(secret: string, kind: RestoreLinkKind, uid: string, stamp: number): string {
  return `${uid}.${stamp}.${sign(secret, kind, uid, stamp)}`;
}

export function readRestoreToken(secret: string, kind: RestoreLinkKind, token: string): { uid: string; stamp: number } | null {
  const m = /^([A-Za-z0-9_-]{1,128})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const stamp = Number(m[2]);
  const want = Buffer.from(sign(secret, kind, m[1], stamp));
  const got = Buffer.from(m[3]);
  return want.length === got.length && timingSafeEqual(want, got) ? { uid: m[1], stamp } : null;
}

const invalid = () => new HttpError(400, 'link_invalid', 'This link has expired or was already used.');

export interface RestoreDeps {
  db: Firestore;
  accounts: AccountAdmin;
  mail: EmailDeps;
  secret: string;
  now?: () => number;
}

/** "Cancel deletion" from the email link: restores the account straight away. */
export async function cancelDeletion(deps: RestoreDeps, token: string): Promise<{ email: string | null }> {
  const now = (deps.now ?? Date.now)();
  const t = readRestoreToken(deps.secret, 'cancel', token);
  if (!t) throw invalid();
  const p = (await deps.db.get<ProfileStatus>(`users/${t.uid}`))?.data;
  if (!p || p.accountStatus !== 'deleted' || p.deletedBy !== 'user' || p.deletionStamp !== t.stamp || !p.purgeAfter || p.purgeAfter <= now)
    throw invalid();
  const account = await deps.accounts.get(t.uid);
  if (!account) throw invalid();
  await restoreAccount(deps.db, { uid: t.uid, email: account.email }, account, now, 'user');
  await closeRequest(deps.db, t.uid, 'restored', now, null);
  return { email: account.email };
}

/** Per-key sliding window kept in rateLimits/{key}; throws 429 when over. */
async function rateLimit(db: Firestore, key: string, now: number, perHour: number, perDay: number) {
  const path = `rateLimits/${key}`;
  const sends = ((await db.get<{ sends?: number[] }>(path))?.data.sends ?? []).filter((x) => now - x < DAY);
  if (sends.filter((x) => now - x < HOUR).length >= perHour || sends.length >= perDay)
    throw new HttpError(429, 'too_many_requests', 'Too many requests. Please try again later.');
  await db.set(path, { sends: [...sends, now] });
}

const hmacKey = (secret: string, v: string) => createHmac('sha256', secret).update(v).digest('hex').slice(0, 40);

/**
 * Sign-in screen: ask for a deleted account back. Always answers the same way;
 * only an account that is scheduled for deletion and still recoverable gets an email.
 */
export async function requestRestore(deps: RestoreDeps, rawEmail: string, reason: string | undefined, ip: string): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  await rateLimit(deps.db, `rr_ip_${hmacKey(deps.secret, ip)}`, now, 10, 30);
  await rateLimit(deps.db, `rr_em_${hmacKey(deps.secret, email)}`, now, 3, 5);

  const account = await deps.accounts.getByEmail(email);
  if (!account) return;
  const p = (await deps.db.get<ProfileStatus>(`users/${account.uid}`))?.data;
  if (!p || p.accountStatus !== 'deleted' || !p.purgeAfter || p.purgeAfter <= now) return;
  const prev = (await deps.db.get<RestoreRequest>(`restoreRequests/${account.uid}`))?.data;
  if (prev?.status === 'pending') return; // already waiting for an administrator

  const req: RestoreRequest = {
    uid: account.uid,
    email: account.email ?? email,
    reason: reason?.trim().slice(0, 500) || null,
    status: 'unconfirmed',
    stamp: now,
    createdAt: now,
    confirmedAt: null,
    decidedAt: null,
    decidedBy: null,
    purgeAfter: p.purgeAfter,
    deletedBy: p.deletedBy ?? 'admin',
  };
  await deps.db.set(`restoreRequests/${account.uid}`, req);
  await recordSecurityEvent(deps.db, account.uid, 'restore_requested', { detail: req.reason ? `Reason: ${req.reason}` : 'No reason given' }, now);
  await sendEmail(deps.mail, {
    type: 'restore_confirm',
    category: 'critical',
    to: req.email,
    uid: account.uid,
    data: { name: account.displayName, at: now, restoreToken: restoreToken(deps.secret, 'confirm', account.uid, now), purgeAfter: p.purgeAfter },
  });
}

/** The person confirmed the request from the email: it now waits for an administrator. */
export async function confirmRestore(deps: RestoreDeps, token: string): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const t = readRestoreToken(deps.secret, 'confirm', token);
  if (!t) throw invalid();
  const path = `restoreRequests/${t.uid}`;
  const r = (await deps.db.get<RestoreRequest>(path))?.data;
  if (!r || r.stamp !== t.stamp) throw invalid();
  if (r.status === 'pending') return; // pressed twice
  if (r.status !== 'unconfirmed' || now - r.stamp > CONFIRM_TTL_MS) throw invalid();
  const p = (await deps.db.get<ProfileStatus>(`users/${t.uid}`))?.data;
  if (!p || p.accountStatus !== 'deleted' || !p.purgeAfter || p.purgeAfter <= now) throw invalid();
  await deps.db.set(path, { status: 'pending', confirmedAt: now }, true);
  await recordSecurityEvent(deps.db, t.uid, 'restore_confirmed', { detail: 'Email address confirmed; waiting for an administrator' }, now);
}

/** Every request, newest first (Admin › Activity & Requests history). */
export async function allRestoreRequests(db: Firestore, limit = 200): Promise<RestoreRequest[]> {
  const rows = await db.list<RestoreRequest>('restoreRequests', { limit });
  return rows.map((r) => r.data).sort((a, b) => b.createdAt - a.createdAt);
}

/** Confirmed requests waiting for a decision (Admin › Users). */
export async function pendingRestoreRequests(db: Firestore): Promise<RestoreRequest[]> {
  const rows = await db.list<RestoreRequest>('restoreRequests', { where: [['status', 'EQUAL', 'pending']], limit: 100 });
  return rows.map((r) => r.data).sort((a, b) => (a.confirmedAt ?? a.createdAt) - (b.confirmedAt ?? b.createdAt));
}

/** Mark the request decided and tell the person (only when a confirmed request was waiting). */
export async function closeRequest(db: Firestore, uid: string, outcome: 'restored' | 'declined', now: number, adminUid: string | null, mail?: EmailDeps) {
  const path = `restoreRequests/${uid}`;
  const r = (await db.get<RestoreRequest>(path))?.data;
  if (!r || (r.status !== 'pending' && r.status !== 'unconfirmed')) return false;
  await db.set(path, { status: outcome, decidedAt: now, decidedBy: adminUid }, true);
  if (mail && r.status === 'pending')
    await sendEmail(mail, {
      type: 'restore_result',
      category: 'critical',
      to: r.email,
      uid,
      data: { at: now, restoreOutcome: outcome, contact: CONTACT_EMAIL, purgeAfter: r.purgeAfter ?? undefined },
    }).catch(() => undefined);
  return r.status === 'pending';
}

/**
 * Daily job: one reminder 7 days before permanent deletion, for accounts their
 * owner deleted (with the cancel link). Returns how many were sent.
 */
export async function remindDue(deps: RestoreDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const due = await deps.db.list<ProfileStatus & { displayName?: string | null }>('users', {
    where: [['accountStatus', 'EQUAL', 'deleted']],
    limit: 200,
  });
  let sent = 0;
  for (const d of due) {
    const p = d.data;
    if (p.deletedBy !== 'user' || !p.purgeAfter || !p.deletionStamp || !p.email || p.deletionReminderAt) continue;
    const left = p.purgeAfter - now;
    if (left <= 0 || left > REMIND_BEFORE_MS) continue;
    // mark first: a failed send is not retried every day
    await deps.db.set(`users/${d.id}`, { deletionReminderAt: now }, true);
    const r = await sendEmail(deps.mail, {
      type: 'deletion_reminder',
      category: 'critical',
      to: p.email,
      uid: d.id,
      data: {
        name: p.displayName ?? null,
        at: now,
        purgeAfter: p.purgeAfter,
        contact: CONTACT_EMAIL,
        restoreToken: restoreToken(deps.secret, 'cancel', d.id, p.deletionStamp),
      },
    }).catch(() => null);
    if (r?.sent) sent++;
  }
  return sent;
}
