/**
 * SMS activity log for the admin dashboard: smsLog/{id}, server-only (the
 * Firestore catch-all rule denies every client). Never holds a code, a code
 * hash or the message body.
 *
 * Delivery states (what we can actually know):
 * - pending      the provider accepted the request; no receipt yet
 * - sent         handed to the mobile network ("sent" does not mean delivered)
 * - delivered    the network reported delivery to the handset
 * - failed       rejected by the provider or not delivered by the network
 * - unavailable  no report yet from a route without delivery receipts (Vynfy's
 *                OTP service only reports 'sent' and 'verified' through its status call)
 */
import { randomBytes } from 'node:crypto';
import type { Firestore } from '../firestore.js';
import type { DeliveryReport, OtpGateway, SmsProvider } from './provider.js';

export type SmsPurpose = 'verify' | 'recovery' | 'support';
export type SmsRoute = 'otp' | 'sms';
export type Delivery = 'pending' | 'sent' | 'delivered' | 'failed' | 'unavailable';
export type Outcome = 'none' | 'verified' | 'wrong_code' | 'expired' | 'locked';

export interface SmsLogEntry {
  at: number;
  updatedAt: number;
  uid: string | null;
  purpose: SmsPurpose;
  route: SmsRoute;
  /** E.164; admins already see users' numbers */
  phone: string;
  /** Vynfy otp_id (OTP route) or task_id (SMS route) */
  ref: string | null;
  messageId?: string | null;
  /** request accepted by the provider? */
  accepted: boolean;
  delivery: Delivery;
  /** raw provider status, e.g. not_delivered */
  providerStatus?: string | null;
  /** Vynfy's error / failure text */
  error?: string | null;
  httpStatus?: number | null;
  /** verification outcome for this code */
  outcome: Outcome;
  verifiedAt?: number | null;
  /** processed webhook event keys (idempotency) */
  events?: string[];
}

const RANK: Record<Delivery, number> = { unavailable: 0, pending: 1, sent: 2, delivered: 3, failed: 3 };

/** Vynfy per-recipient status -> delivery state. */
export function deliveryOf(status: string | undefined | null): Delivery {
  const s = (status ?? '').toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (['not_delivered', 'undelivered', 'failed', 'rejected', 'expired', 'error'].includes(s)) return 'failed';
  if (s === 'sent' || s === 'submitted') return 'sent';
  return 'pending';
}

/** Forward-only: a late "sent" never overwrites "delivered" or "failed". */
export function advances(from: Delivery, to: Delivery) {
  if (from === 'delivered' || from === 'failed') return false;
  return RANK[to] > RANK[from];
}

export async function logSms(db: Firestore, entry: Omit<SmsLogEntry, 'updatedAt' | 'outcome'> & { outcome?: Outcome }): Promise<string> {
  const id = `${entry.at.toString(36)}-${randomBytes(4).toString('hex')}`;
  try {
    await db.set(`smsLog/${id}`, { outcome: 'none', ...entry, updatedAt: entry.at } satisfies SmsLogEntry);
  } catch (err) {
    console.error('[sms] log write failed', (err as Error).message);
  }
  return id;
}

export async function updateSms(db: Firestore, id: string | null | undefined, patch: Partial<SmsLogEntry>, now = Date.now()) {
  if (!id) return;
  try {
    await db.set(`smsLog/${id}`, { ...patch, updatedAt: now }, true);
  } catch (err) {
    console.error('[sms] log update failed', (err as Error).message);
  }
}

/**
 * Vynfy OTP status -> delivery state. Observed live: 'sent' once the code is
 * handed to the network. Other values (pending, verified, expired, failed)
 * describe the code, not the text; a verified code may have been read through
 * Vynfy's USSD menu, so it does not prove the text arrived.
 */
export function otpDeliveryOf(status: string | undefined | null): Delivery | null {
  const s = (status ?? '').toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (s === 'sent') return 'sent';
  return null;
}

/** Poll the provider for an entry still in flight (free status calls). */
export async function refreshDelivery(db: Firestore, sms: SmsProvider | null, id: string, e: SmsLogEntry, now = Date.now(), otp?: OtpGateway | null): Promise<SmsLogEntry> {
  if (!e.ref || !e.accepted || e.delivery === 'delivered' || e.delivery === 'failed') return e;
  if (e.route === 'otp') {
    if (!otp?.status || e.delivery === 'sent') return e;
    let st: { status: string } | null;
    try {
      st = await otp.status(e.ref);
    } catch {
      return e;
    }
    const delivery = otpDeliveryOf(st?.status);
    if (!st || !delivery || !advances(e.delivery, delivery)) return e;
    const patch: Partial<SmsLogEntry> = { providerStatus: st.status, delivery };
    await updateSms(db, id, patch, now);
    return { ...e, ...patch };
  }
  if (!sms?.delivery) return e;
  let r: DeliveryReport | null;
  try {
    r = await sms.delivery(e.ref);
  } catch {
    return e;
  }
  if (!r) return e;
  const delivery = deliveryOf(r.status);
  if (r.status === e.providerStatus && delivery === e.delivery) return e;
  const patch: Partial<SmsLogEntry> = {
    providerStatus: r.status,
    messageId: r.messageId ?? e.messageId ?? null,
    ...(advances(e.delivery, delivery) ? { delivery } : {}),
    ...(r.error ? { error: r.error } : delivery === 'failed' && !e.error ? { error: `Vynfy status: ${r.status}` } : {}),
  };
  await updateSms(db, id, patch, now);
  return { ...e, ...patch };
}

export interface SmsOverview {
  totals: { requests: number; accepted: number; rejected: number; delivered: number; failed: number; pending: number; noReceipt: number; verified: number; verificationRate: number | null };
  recent: (SmsLogEntry & { id: string })[];
}

/** Stats over the most recent entries (up to 500) and the latest 60 rows. */
export async function smsOverview(db: Firestore, sms: SmsProvider | null, now = Date.now(), otp?: OtpGateway | null): Promise<SmsOverview> {
  const docs = await db.list<SmsLogEntry>('smsLog', { orderBy: 'at', direction: 'DESCENDING', limit: 500 });
  const rows = docs.map((d) => ({ ...d.data, id: d.id }));
  // Refresh in-flight receipts from the last 3 days (free status calls, at most 15).
  const inFlight = (r: SmsLogEntry) => (r.route === 'sms' ? r.delivery === 'pending' || r.delivery === 'sent' : r.delivery === 'unavailable');
  const stale = rows.filter((r) => r.accepted && inFlight(r) && now - r.at < 3 * 86_400_000).slice(0, 15);
  await Promise.all(stale.map(async (r) => Object.assign(r, await refreshDelivery(db, sms, r.id, r, now, otp))));
  const verify = rows.filter((r) => r.purpose === 'verify' && r.accepted);
  const verified = verify.filter((r) => r.outcome === 'verified').length;
  return {
    totals: {
      requests: rows.length,
      accepted: rows.filter((r) => r.accepted).length,
      rejected: rows.filter((r) => !r.accepted).length,
      delivered: rows.filter((r) => r.delivery === 'delivered').length,
      failed: rows.filter((r) => r.accepted && r.delivery === 'failed').length,
      pending: rows.filter((r) => r.accepted && (r.delivery === 'pending' || r.delivery === 'sent')).length,
      noReceipt: rows.filter((r) => r.accepted && r.delivery === 'unavailable').length,
      verified,
      verificationRate: verify.length ? Math.round((verified / verify.length) * 100) : null,
    },
    recent: rows.slice(0, 60),
  };
}
