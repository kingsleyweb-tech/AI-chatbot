/**
 * Email activity log for the admin dashboard: emailLog/{id}, server-only (the
 * Firestore catch-all rule denies every client). Holds the type, a masked
 * recipient and the provider's status: never the subject, the body, a code
 * or the full address.
 *
 * Status (what we actually know):
 * - accepted   the provider took the email (HTTP 201 with a message id); NOT proof of delivery
 * - delivered  the provider reported the receiving mail server accepted it
 * - deferred   the receiving server delayed it; the provider keeps retrying
 * - bounced    soft or hard bounce
 * - blocked    the provider refused to send it (blocked address, invalid, spam complaint list…)
 * - failed     the send request itself failed (network, key, IP restriction, quota…)
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Firestore } from '../firestore.js';
import type { EmailEvent, EmailProvider } from './provider.js';
import type { EmailType } from './templates.js';

export type EmailStatus = 'accepted' | 'delivered' | 'deferred' | 'bounced' | 'blocked' | 'failed';

export interface EmailLogEntry {
  at: number;
  updatedAt: number;
  uid: string | null;
  type: EmailType;
  /** e.g. "ki•••@gmail.com" */
  to: string;
  provider: string;
  /** masked sender address used, e.g. "ki•••@gmail.com" */
  from?: string | null;
  messageId: string | null;
  accepted: boolean;
  status: EmailStatus;
  /** provider's last event name, e.g. hardBounces */
  providerStatus?: string | null;
  error?: string | null;
  errorCode?: string | null;
  httpStatus?: number | null;
  attempts?: number;
  /** the person opened it (reported by the provider; not always reliable) */
  opened?: boolean;
}

/** "kingsley@gmail.com" -> "ki•••@gmail.com" */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 2)}•••@${domain}`;
}

export const emailHash = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);

export async function logEmail(
  db: Firestore,
  entry: Omit<EmailLogEntry, 'updatedAt'>,
): Promise<string> {
  const id = `${entry.at.toString(36)}-${randomBytes(4).toString('hex')}`;
  try {
    await db.set(`emailLog/${id}`, { ...entry, updatedAt: entry.at } satisfies EmailLogEntry);
  } catch (err) {
    console.error('[email] log write failed', (err as Error).message);
  }
  return id;
}

const FINAL: EmailStatus[] = ['delivered', 'bounced', 'blocked', 'failed'];

/** Provider events (newest first or any order) -> the most definite status. */
export function statusFromEvents(events: EmailEvent[]): {
  status: EmailStatus | null;
  providerStatus: string | null;
  reason: string | null;
  opened: boolean;
} {
  const names = events.map((e) => e.event);
  const pick = (...ev: string[]) => events.find((e) => ev.includes(e.event)) ?? null;
  const opened = names.some((n) => n === 'opened' || n === 'clicks' || n === 'loadedByProxy');
  const bad = pick('hardBounces', 'softBounces', 'blocked', 'invalid', 'error');
  if (bad) {
    const status: EmailStatus =
      bad.event === 'hardBounces' || bad.event === 'softBounces' ? 'bounced' : 'blocked';
    return { status, providerStatus: bad.event, reason: bad.reason ?? null, opened };
  }
  const ok = pick('delivered');
  if (ok || opened)
    return { status: 'delivered', providerStatus: ok?.event ?? 'opened', reason: null, opened };
  const deferred = pick('deferred');
  if (deferred)
    return {
      status: 'deferred',
      providerStatus: 'deferred',
      reason: deferred.reason ?? null,
      opened,
    };
  return { status: null, providerStatus: names[0] ?? null, reason: null, opened };
}

/** Ask the provider what happened to an accepted email (free status call). */
export async function refreshEmail(
  db: Firestore,
  provider: EmailProvider | null,
  id: string,
  e: EmailLogEntry,
  now = Date.now(),
): Promise<EmailLogEntry> {
  if (!provider?.events || !e.messageId || !e.accepted || FINAL.includes(e.status)) return e;
  let events: EmailEvent[] | null;
  try {
    events = await provider.events(e.messageId);
  } catch {
    return e;
  }
  if (!events?.length) return e;
  const s = statusFromEvents(events);
  const patch: Partial<EmailLogEntry> = {};
  if (s.status && s.status !== e.status) patch.status = s.status;
  if (s.providerStatus && s.providerStatus !== e.providerStatus)
    patch.providerStatus = s.providerStatus;
  if (s.reason && !e.error) patch.error = s.reason;
  if (s.opened && !e.opened) patch.opened = true;
  if (!Object.keys(patch).length) return e;
  try {
    await db.set(`emailLog/${id}`, { ...patch, updatedAt: now }, true);
  } catch (err) {
    console.error('[email] log update failed', (err as Error).message);
  }
  return { ...e, ...patch };
}

export interface EmailOverview {
  totals: {
    requests: number;
    accepted: number;
    failed: number;
    delivered: number;
    deferred: number;
    bounced: number;
    blocked: number;
    awaiting: number;
  };
  byType: Record<string, number>;
  recent: (EmailLogEntry & { id: string })[];
}

/** Email records are kept 90 days (Privacy Policy), then removed by the daily cron. */
export const EMAIL_LOG_RETENTION_DAYS = 90;

export async function pruneEmailLog(db: Firestore, now = Date.now()): Promise<number> {
  const old = await db.list<EmailLogEntry>('emailLog', {
    where: [['at', 'LESS_THAN', now - EMAIL_LOG_RETENTION_DAYS * 86_400_000]],
    limit: 400,
  });
  if (old.length) await db.commit(old.map((d) => ({ op: 'delete' as const, path: d.path })));
  return old.length;
}

/** Permanent deletion: the account's email records go too. */
export async function deleteEmailLogOf(db: Firestore, uid: string): Promise<number> {
  let n = 0;
  for (let guard = 0; guard < 50; guard++) {
    const rows = await db.list<EmailLogEntry>('emailLog', { where: [['uid', 'EQUAL', uid]], limit: 400 });
    if (!rows.length) break;
    await db.commit(rows.map((d) => ({ op: 'delete' as const, path: d.path })));
    n += rows.length;
  }
  return n;
}

/** Stats over the most recent 500 entries and the latest 60 rows. Delivered counts only provider-confirmed deliveries. */
export async function emailOverview(
  db: Firestore,
  provider: EmailProvider | null,
  now = Date.now(),
): Promise<EmailOverview> {
  const docs = await db.list<EmailLogEntry>('emailLog', {
    orderBy: 'at',
    direction: 'DESCENDING',
    limit: 500,
  });
  const rows = docs.map((d) => ({ ...d.data, id: d.id }));
  // Refresh up to 15 accepted emails from the last 3 days that have no final status yet.
  const stale = rows
    .filter((r) => r.accepted && !FINAL.includes(r.status) && now - r.at < 3 * 86_400_000)
    .slice(0, 15);
  await Promise.all(
    stale.map(async (r) => Object.assign(r, await refreshEmail(db, provider, r.id, r, now))),
  );
  const count = (f: (r: EmailLogEntry) => boolean) => rows.filter(f).length;
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;
  return {
    totals: {
      requests: rows.length,
      accepted: count((r) => r.accepted),
      failed: count((r) => !r.accepted),
      delivered: count((r) => r.status === 'delivered'),
      deferred: count((r) => r.status === 'deferred'),
      bounced: count((r) => r.status === 'bounced'),
      blocked: count((r) => r.status === 'blocked'),
      awaiting: count((r) => r.accepted && r.status === 'accepted'),
    },
    byType,
    recent: rows.slice(0, 60),
  };
}
