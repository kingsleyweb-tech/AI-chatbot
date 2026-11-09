/**
 * Text messages the app sends about an account (approval, administrator
 * messages), and the "your account was approved" notice.
 *
 * Every text is counted against an app-wide daily cap (smsStats/{day}) and
 * logged in smsLog like verification codes. Only verified numbers receive
 * texts. Nothing here throws: a failed email or SMS never fails the
 * administrator's action.
 */
import type { AccountAdmin } from '../admin.js';
import type { Firestore } from '../firestore.js';
import { sendEmail, type EmailDeps, type SendOutcome } from '../email/service.js';
import { deliveryOf, logSms, type SmsPurpose } from '../sms/log.js';
import type { SmsProvider } from '../sms/provider.js';

export type SmsNoticeResult = 'sent' | 'failed' | 'skipped' | 'no_phone' | 'limited';

/**
 * Send one text if the day's counter for `counter` is under `cap`.
 * The counter is increased only when the provider accepts the message.
 */
export async function sendNoticeSms(
  db: Firestore,
  sms: SmsProvider | null,
  o: {
    uid: string | null;
    phone: string | null | undefined;
    text: string;
    purpose: SmsPurpose;
    counter: 'notify' | 'message';
    cap: number;
    now: number;
  },
): Promise<SmsNoticeResult> {
  if (!sms) return 'skipped';
  if (!o.phone) return 'no_phone';
  const day = new Date(o.now).toISOString().slice(0, 10);
  const stats = await db.get<Record<string, number>>(`smsStats/${day}`);
  if ((stats?.data[o.counter] ?? 0) >= o.cap) return 'limited';
  const entry = { at: o.now, uid: o.uid, purpose: o.purpose, route: 'sms' as const, phone: o.phone };
  try {
    const r = await sms.send(o.phone, o.text);
    await db
      .commit([{ op: 'increment', path: `smsStats/${day}`, increments: { [o.counter]: 1 } }])
      .catch(() => undefined);
    await logSms(db, {
      ...entry,
      ref: r.id ?? null,
      accepted: true,
      delivery: deliveryOf(r.status),
      providerStatus: r.status ?? 'queued',
    }).catch(() => undefined);
    return 'sent';
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : 'SMS failed';
    console.error(`[sms] ${o.purpose} text failed`, message);
    await logSms(db, { ...entry, ref: null, accepted: false, delivery: 'failed', error: message }).catch(
      () => undefined,
    );
    return 'failed';
  }
}

export interface ApprovalNoticeDeps {
  db: Firestore;
  mail: EmailDeps | null;
  sms: SmsProvider | null;
  accounts: AccountAdmin;
  baseUrl: string;
  smsDailyCap: number;
  now?: () => number;
}

export function approvalSmsText(baseUrl: string): string {
  return `Atlas AI: your account has been approved. You can now sign in at ${baseUrl.replace(/^https?:\/\//, '')}`;
}

/**
 * "Your account has been approved": an email to the account's address and a
 * text to its verified number. Sent once per approval (deduplicated for a day).
 */
export async function accessApprovedNotice(
  deps: ApprovalNoticeDeps,
  uid: string,
): Promise<{ email: SendOutcome['status'] | 'skipped'; sms: SmsNoticeResult }> {
  const now = (deps.now ?? Date.now)();
  const result: { email: SendOutcome['status'] | 'skipped'; sms: SmsNoticeResult } = {
    email: 'skipped',
    sms: 'skipped',
  };
  try {
    const [account, profile] = await Promise.all([
      deps.accounts.get(uid).catch(() => null),
      deps.db.get<{ displayName?: string; phoneNumber?: string | null; phoneVerified?: boolean }>(
        `users/${uid}`,
      ),
    ]);
    if (!account || account.disabled) return result;
    const p = profile?.data ?? {};
    const name = p.displayName || account.displayName || null;
    if (deps.mail && account.email) {
      const r = await sendEmail(deps.mail, {
        type: 'access_approved',
        category: 'critical',
        to: account.email,
        uid,
        data: { name },
        dedupeKey: `approved|${uid}`,
        dedupeMs: 24 * 3_600_000,
      });
      result.email = r.status;
    }
    result.sms = await sendNoticeSms(deps.db, deps.sms, {
      uid,
      phone: p.phoneVerified === true ? p.phoneNumber : null,
      text: approvalSmsText(deps.baseUrl),
      purpose: 'approval',
      counter: 'notify',
      cap: deps.smsDailyCap,
      now,
    });
  } catch (err) {
    console.warn('[approval] notice skipped', err instanceof Error ? err.message : err);
  }
  return result;
}
