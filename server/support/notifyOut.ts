/**
 * Email and text-message notices about a support report, sent after an
 * administrator replies or changes its status (the in-app notification is
 * written by reports.ts). Best effort: nothing here throws, so an email or
 * SMS problem never fails the administrator's action.
 *
 * - Email: every reply and status change, to a verified address only, unless
 *   the person turned "Support updates" off.
 * - SMS: only the updates that need the person: "resolved" and "we need more
 *   information". Only to a verified phone number, unless "supportSms" is off,
 *   and within three limits: 2 per report and 5 per person per 24 hours, and
 *   SMS_NOTIFY_DAILY_CAP for the whole app per day. The text never contains
 *   the report's content.
 */
import type { AccountAdmin } from '../admin.js';
import type { Firestore } from '../firestore.js';
import { prefsFrom, sendEmail, type EmailDeps, type SendOutcome } from '../email/service.js';
import { deliveryOf, logSms } from '../sms/log.js';
import type { SmsProvider } from '../sms/provider.js';
import { SUPPORT_STATUSES, type SupportStatus } from '../shared/support.js';

export type SupportNoticeKind = 'reply' | 'info_request' | 'status' | 'resolved';

export interface SupportNoticeDeps {
  db: Firestore;
  mail: EmailDeps | null;
  sms: SmsProvider | null;
  accounts: AccountAdmin;
  baseUrl: string;
  smsDailyCap: number;
  now?: () => number;
}

export interface SupportNoticeReport {
  ref: string;
  uid: string;
  title: string;
  status: SupportStatus;
}

export interface SupportNoticeResult {
  email: SendOutcome['status'] | 'skipped';
  sms: 'sent' | 'failed' | 'skipped' | 'opted_out' | 'no_phone' | 'limited';
}

const DAY = 86_400_000;
const SMS_PER_REPORT = 2;
const SMS_PER_USER = 5;
const SMS_KINDS: SupportNoticeKind[] = ['resolved', 'info_request'];

const label = (s: SupportStatus) => SUPPORT_STATUSES.find((x) => x.id === s)?.label ?? s;

interface NoticeProfile {
  displayName?: string;
  phoneNumber?: string;
  phoneVerified?: boolean;
  emailPrefs?: unknown;
}

/** Keep a rolling 24-hour list of send times; false when the limit is reached. */
async function claim(db: Firestore, path: string, limit: number, now: number): Promise<boolean> {
  const doc = await db.get<{ sends?: number[] }>(path);
  const recent = (doc?.data.sends ?? []).filter((t) => now - t < DAY);
  if (recent.length >= limit) return false;
  await db.set(path, { sends: [...recent, now] });
  return true;
}

export function supportSmsText(kind: SupportNoticeKind, ref: string, baseUrl: string): string {
  const link = `${baseUrl.replace(/^https?:\/\//, '')}/support/${ref}`;
  return kind === 'resolved'
    ? `Atlas AI: your report ${ref} has been resolved. Please confirm, or reopen it if the problem continues: ${link}`
    : `Atlas AI: our support team needs more information about your report ${ref}. Please reply here: ${link}`;
}

export async function supportUpdateNotice(
  deps: SupportNoticeDeps,
  report: SupportNoticeReport,
  kind: SupportNoticeKind,
  opts: { reply?: string | null } = {},
): Promise<SupportNoticeResult> {
  const now = (deps.now ?? Date.now)();
  const result: SupportNoticeResult = { email: 'skipped', sms: 'skipped' };
  try {
    const [account, profileDoc] = await Promise.all([
      deps.accounts.get(report.uid).catch(() => null),
      deps.db.get<NoticeProfile>(`users/${report.uid}`),
    ]);
    const profile = profileDoc?.data ?? {};
    const name = profile.displayName || account?.displayName || null;

    // Email, only to an address the person proved they own.
    if (deps.mail && account?.email && account.emailVerified) {
      const r = await sendEmail(deps.mail, {
        type: 'support_update',
        category: 'support',
        to: account.email,
        uid: report.uid,
        data: {
          name,
          support: {
            ref: report.ref,
            title: report.title,
            kind,
            status: label(report.status),
            reply: opts.reply ?? null,
          },
        },
        dedupeKey: `support|${report.ref}|${kind}|${Math.floor(now / 600_000)}`,
        dedupeMs: 10 * 60_000,
      });
      result.email = r.status;
    }

    // SMS, only for the updates that need the person.
    if (!SMS_KINDS.includes(kind) || !deps.sms) return result;
    if (!prefsFrom(profile.emailPrefs).supportSms) return { ...result, sms: 'opted_out' };
    if (profile.phoneVerified !== true || !profile.phoneNumber)
      return { ...result, sms: 'no_phone' };
    const day = new Date(now).toISOString().slice(0, 10);
    const stats = await deps.db.get<{ notify?: number }>(`smsStats/${day}`);
    if ((stats?.data.notify ?? 0) >= deps.smsDailyCap) {
      console.warn('[support] SMS notice daily cap reached');
      return { ...result, sms: 'limited' };
    }
    if (!(await claim(deps.db, `rateLimits/sr_${report.ref}`, SMS_PER_REPORT, now)))
      return { ...result, sms: 'limited' };
    if (!(await claim(deps.db, `rateLimits/su_${report.uid}`, SMS_PER_USER, now)))
      return { ...result, sms: 'limited' };

    const entry = {
      at: now,
      uid: report.uid,
      purpose: 'support' as const,
      route: 'sms' as const,
      phone: profile.phoneNumber,
    };
    try {
      const r = await deps.sms.send(
        profile.phoneNumber,
        supportSmsText(kind, report.ref, deps.baseUrl),
      );
      await deps.db
        .commit([{ op: 'increment', path: `smsStats/${day}`, increments: { notify: 1 } }])
        .catch(() => undefined);
      await logSms(deps.db, {
        ...entry,
        ref: r.id ?? null,
        accepted: true,
        delivery: deliveryOf(r.status),
        providerStatus: r.status ?? 'queued',
      });
      return { ...result, sms: 'sent' };
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : 'SMS failed';
      console.error('[support] SMS notice failed', message);
      await logSms(deps.db, {
        ...entry,
        ref: null,
        accepted: false,
        delivery: 'failed',
        error: message,
      });
      return { ...result, sms: 'failed' };
    }
  } catch (err) {
    console.warn('[support] notice skipped', err instanceof Error ? err.message : err);
    return result;
  }
}
