/**
 * One-time SMS codes that verify a phone number.
 *
 * Route "otp" (default): Vynfy's OTP service generates, texts, stores and
 * checks the code (POST /otp/generate, POST /otp/verify). We never see the
 * code. Vynfy allows one pending code per number and 3 verify attempts, and
 * enforces the expiry we pass.
 *
 * Route "sms" (fallback, or VYNFY_OTP=0): a 6-digit code from
 * crypto.randomInt, sent as an ordinary SMS. Only an HMAC of the code is
 * stored, in server-only documents (otp/{uid}; the rules deny all clients).
 *
 * Both routes:
 * - The number is verified only after a successful verify call, never
 *   because a send was accepted.
 * - 60 s resend cooldown; at most 3 codes per hour and 10 per day per account
 *   and per phone number; an app-wide daily cap protects the balance.
 * - Wrong attempts are counted here too, with an optimistic-concurrency
 *   precondition, so parallel guesses cannot skip the count.
 * - A phone number can verify only one account (phoneNumbers/{hash}).
 * - Each send is recorded in smsLog for the admin dashboard (no codes).
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Firestore, Write } from '../firestore.js';
import { HttpError } from '../http.js';
import { deliveryOf, logSms, refreshDelivery, updateSms, type SmsLogEntry } from '../sms/log.js';
import { SmsError, type OtpGateway, type SmsProvider } from '../sms/provider.js';
import { formatPhone, maskPhone, normalizePhone } from './phone.js';

export const CODE_TTL_MS = 5 * 60_000;
export const RESEND_MS = 60_000;
/** wrong attempts allowed per app-generated code */
export const MAX_ATTEMPTS = 5;
/** Vynfy's OTP service allows 3 attempts */
export const OTP_MAX_ATTEMPTS = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PER_HOUR = 3;
const PER_DAY = 10;
/** USSD code Vynfy documents for reading a pending OTP on the handset */
export const OTP_USSD = '*928*01#';

export interface OtpDeps {
  db: Firestore;
  /** ordinary SMS (fallback route and password resets) */
  sms: SmsProvider | null;
  /** Vynfy OTP service; null = app-generated codes over ordinary SMS */
  otp?: OtpGateway | null;
  secret: string;
  dailyCap: number;
  otpLength?: number;
  otpExpiryMin?: number;
  /** fall back to the SMS route when the OTP balance is empty */
  smsFallback?: boolean;
  now?: () => number;
}

interface OtpDoc {
  phone?: string;
  phoneHash?: string;
  route?: 'otp' | 'sms';
  /** Vynfy otp_id while a provider code is pending */
  otpId?: string | null;
  codeHash?: string | null;
  codeLength?: number;
  expiresAt?: number;
  attempts?: number;
  sentAt?: number;
  sends?: number[];
  verifiedPhoneHash?: string | null;
  /** smsLog id of the latest send */
  logId?: string | null;
}

const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');
export const phoneKey = (secret: string, e164: string) => hmac(secret, `phone|${e164}`);
const codeKey = (secret: string, uid: string, e164: string, code: string) => hmac(secret, `code|${uid}|${e164}|${code}`);

function sameHash(a: string, b: string) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function limited(stamps: number[] | undefined, now: number) {
  const recent = (stamps ?? []).filter((t) => now - t < DAY);
  return { recent, hour: recent.filter((t) => now - t < HOUR).length, day: recent.length };
}

function tooMany(code: string, message: string, retryAfter: number, extra?: Record<string, unknown>): never {
  throw new HttpError(429, code, message, { retryAfter: Math.max(1, Math.ceil(retryAfter / 1000)), ...extra });
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Message for the SMS route (app-generated code). */
export function smsText(code: string) {
  return `Your Atlas AI verification code is ${code}. It expires in 5 minutes. Do not share it.`;
}

/** Template for Vynfy's OTP service (max 160 characters, %otp_code% required). */
export function otpTemplate(expiryMin: number) {
  return `Your Atlas AI verification code is %otp_code%. It expires in ${expiryMin} minute${expiryMin === 1 ? '' : 's'}. Do not share it.`;
}

/** A code is waiting to be entered. */
function isActive(d: OtpDoc | undefined, now: number) {
  return Boolean(d && (d.codeHash || d.otpId) && (d.expiresAt ?? 0) > now);
}

const maxAttempts = (d: OtpDoc | undefined) => (d?.route === 'otp' ? OTP_MAX_ATTEMPTS : MAX_ATTEMPTS);

/** Status for the verification screen. Never includes the code or its hash. */
export async function otpStatus(deps: OtpDeps, uid: string) {
  const now = (deps.now ?? Date.now)();
  const d = (await deps.db.get<OtpDoc>(`otp/${uid}`))?.data;
  const active = isActive(d, now);
  let delivery: { state: string; error: string | null } | null = null;
  if (active && d?.logId) {
    const log = await deps.db.get<SmsLogEntry>(`smsLog/${d.logId}`);
    if (log) {
      const e = await refreshDelivery(deps.db, deps.sms, d.logId, log.data, now, deps.otp);
      delivery = { state: e.delivery, error: e.delivery === 'failed' ? (e.error ?? null) : null };
    }
  }
  return {
    pending: active,
    phoneMasked: active && d?.phone ? maskPhone(d.phone) : null,
    phoneDisplay: active && d?.phone ? formatPhone(d.phone) : null,
    route: active ? (d?.route ?? 'sms') : null,
    codeLength: active ? (d?.codeLength ?? 6) : null,
    expiresIn: active ? Math.ceil(((d?.expiresAt ?? 0) - now) / 1000) : 0,
    resendIn: d?.sentAt ? Math.max(0, Math.ceil((d.sentAt + RESEND_MS - now) / 1000)) : 0,
    attemptsLeft: active ? maxAttempts(d) - (d?.attempts ?? 0) : maxAttempts(d),
    delivery,
  };
}

/**
 * Send a code. `rawPhone` may be omitted to resend to the number of the
 * current code.
 */
export async function sendCode(deps: OtpDeps, uid: string, rawPhone?: string | null) {
  const now = (deps.now ?? Date.now)();
  const cur = await deps.db.get<OtpDoc>(`otp/${uid}`);
  const d = cur?.data ?? {};
  const input = rawPhone ?? d.phone;
  if (!input) throw new HttpError(400, 'invalid_phone', 'Enter your mobile number, for example 024 123 4567.');
  const phone = normalizePhone(input);
  if (!phone.ok) {
    throw phone.reason === 'country'
      ? new HttpError(400, 'unsupported_country', 'Only Ghana (+233) mobile numbers can receive verification texts at the moment.')
      : new HttpError(400, 'invalid_phone', 'Enter a valid Ghana mobile number, for example 024 123 4567 or +233 24 123 4567.');
  }
  const e164 = phone.e164;
  const pHash = phoneKey(deps.secret, e164);
  const day = new Date(now).toISOString().slice(0, 10);

  const [owner, perPhone, stats] = await Promise.all([
    deps.db.get<{ uid: string }>(`phoneNumbers/${pHash}`),
    deps.db.get<{ sends?: number[] }>(`otpPhones/${pHash}`),
    deps.db.get<{ sent?: number }>(`otpStats/${day}`),
  ]);
  if (owner && owner.data.uid !== uid) {
    throw new HttpError(409, 'phone_in_use', 'This phone number is already linked to another account.');
  }
  if (d.sentAt && now - d.sentAt < RESEND_MS) {
    tooMany('resend_cooldown', 'Please wait before requesting another code.', d.sentAt + RESEND_MS - now);
  }
  // Vynfy keeps one pending code per number: asking again would fail (and must not cost anything).
  if (d.route === 'otp' && d.otpId && d.phone === e164 && isActive(d, now)) {
    const left = (d.expiresAt ?? 0) - now;
    tooMany(
      'otp_pending',
      `Your last code is still valid for ${mmss(left)}. Texts can take a minute to arrive. You can also dial ${OTP_USSD} on that phone to see the code. A new code can be sent when it expires.`,
      left,
      { ussd: OTP_USSD },
    );
  }
  const mine = limited(d.sends, now);
  const theirs = limited(perPhone?.data.sends, now);
  if (mine.hour >= PER_HOUR || theirs.hour >= PER_HOUR) {
    tooMany('too_many_codes', 'Too many codes requested. Try again in an hour.', HOUR);
  }
  if (mine.day >= PER_DAY || theirs.day >= PER_DAY) {
    tooMany('too_many_codes', 'Too many codes requested today. Try again tomorrow.', DAY);
  }
  if ((stats?.data.sent ?? 0) >= deps.dailyCap) {
    throw new HttpError(503, 'sms_daily_cap', 'Verification texts are paused for today. Please try again tomorrow.');
  }
  if (!deps.otp && !deps.sms) throw new HttpError(503, 'otp_unavailable', 'Phone verification is not configured on the server yet.');

  // Reserve the send (counts toward limits even if delivery fails) before texting.
  const reserve: OtpDoc = { ...d, phone: e164, phoneHash: pHash, otpId: null, codeHash: null, attempts: 0, sentAt: now, sends: [...mine.recent, now], logId: null };
  try {
    await deps.db.commit([
      { op: 'set', path: `otp/${uid}`, data: reserve as Record<string, unknown>, precondition: cur?.updateTime ? { updateTime: cur.updateTime } : { exists: false } },
      { op: 'set', path: `otpPhones/${pHash}`, data: { sends: [...theirs.recent, now] } },
      { op: 'increment', path: `otpStats/${day}`, increments: { sent: 1 } },
    ] satisfies Write[]);
  } catch (err) {
    // Another request changed the record between read and write (a parallel send).
    if ((err as { status?: number }).status === 409) tooMany('resend_cooldown', 'A code was just sent. Please wait.', RESEND_MS);
    throw err;
  }

  const base = { at: now, uid, purpose: 'verify' as const, phone: e164 };
  const release = () => deps.db.set(`otp/${uid}`, { otpId: null, codeHash: null, sentAt: 0 }, true).catch(() => undefined);

  // 1) Vynfy OTP service
  if (deps.otp) {
    const expiryMin = deps.otpExpiryMin ?? 5;
    const length = deps.otpLength ?? 6;
    try {
      const { otpId } = await deps.otp.generate(e164, { message: otpTemplate(expiryMin), length, expiryMin });
      const logId = await logSms(deps.db, { ...base, route: 'otp', ref: otpId, accepted: true, delivery: 'unavailable', providerStatus: 'accepted' });
      await deps.db.set(`otp/${uid}`, { route: 'otp', otpId, codeLength: length, expiresAt: now + expiryMin * 60_000, logId }, true);
      return sendResult(e164, expiryMin * 60, 'otp', length);
    } catch (err) {
      const p = err instanceof SmsError ? err.provider : { message: (err as Error).message };
      await logSms(deps.db, { ...base, route: 'otp', ref: null, accepted: false, delivery: 'failed', error: p.message ?? null, httpStatus: p.httpStatus ?? null, providerStatus: p.code ?? 'rejected' });
      const outOfCredit = err instanceof SmsError && err.code === 'sms_unavailable' && /balance|credit|insufficient/i.test(`${p.code} ${p.message}`);
      // Vynfy's OTP service checks Ghana network prefixes against an outdated list (it refuses
      // MTN 053 with "Invalid Ghana network code: 53"). The number already passed our own check,
      // so the ordinary SMS route is tried instead.
      const prefixRefused = err instanceof SmsError && /network code/i.test(p.message ?? '');
      if (!((outOfCredit || prefixRefused) && deps.smsFallback !== false && deps.sms)) {
        await release();
        throw err;
      }
      // OTP balance empty or prefix refused: fall through to an app-generated code over ordinary SMS.
    }
  }

  // 2) App-generated code over ordinary SMS
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await deps.db.set(`otp/${uid}`, { route: 'sms', codeHash: codeKey(deps.secret, uid, e164, code), codeLength: 6, expiresAt: now + CODE_TTL_MS }, true);
  try {
    const r = await deps.sms!.send(e164, smsText(code));
    const logId = await logSms(deps.db, { ...base, route: 'sms', ref: r.id ?? null, accepted: true, delivery: deliveryOf(r.status), providerStatus: r.status ?? 'queued' });
    await deps.db.set(`otp/${uid}`, { logId }, true);
  } catch (err) {
    const p = err instanceof SmsError ? err.provider : { message: (err as Error).message };
    await logSms(deps.db, { ...base, route: 'sms', ref: null, accepted: false, delivery: 'failed', error: p.message ?? null, httpStatus: p.httpStatus ?? null, providerStatus: p.code ?? 'rejected' });
    // Delivery failed: drop the code and allow an immediate retry (limits still apply).
    await release();
    throw err;
  }
  return sendResult(e164, CODE_TTL_MS / 1000, 'sms', 6);
}

function sendResult(e164: string, expiresIn: number, route: 'otp' | 'sms', codeLength: number) {
  return {
    phoneMasked: maskPhone(e164),
    phoneDisplay: formatPhone(e164),
    expiresIn,
    resendIn: RESEND_MS / 1000,
    route,
    codeLength,
    /** the provider accepted the request; delivery is not confirmed yet */
    delivery: route === 'otp' ? 'unavailable' : 'pending',
  };
}

/** Checks the code; on success the phone is bound to the account and the code is consumed. */
export async function verifyCode(deps: OtpDeps, uid: string, code: string): Promise<{ phone: string }> {
  const now = (deps.now ?? Date.now)();
  const cur = await deps.db.get<OtpDoc>(`otp/${uid}`);
  const d = cur?.data;
  const len = d?.codeLength ?? 6;
  if (!new RegExp(`^\\d{${len}}$`).test(code)) throw new HttpError(400, 'bad_code', `Enter the ${len}-digit code.`);
  if (!cur || !d || !(d.codeHash || d.otpId) || !d.phone || !d.phoneHash) {
    throw new HttpError(400, 'no_code', 'There is no active code. Request a new one.');
  }
  const kill = { otpId: null, codeHash: null };
  if ((d.expiresAt ?? 0) <= now) {
    await updateSms(deps.db, d.logId, { outcome: 'expired' }, now);
    throw new HttpError(400, 'expired', 'This code has expired. Request a new one.');
  }
  const max = maxAttempts(d);
  const attempts = d.attempts ?? 0;
  if (attempts >= max) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');

  // Count the attempt first (precondition = no parallel guess slipped in).
  const used = attempts + 1;
  try {
    await deps.db.commit([{ op: 'set', path: `otp/${uid}`, data: { attempts: used }, merge: true, precondition: { updateTime: cur.updateTime ?? '' } }]);
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw new HttpError(409, 'conflict', 'Please try again.');
    throw err;
  }

  const wrong = async (attemptsLeft?: number): Promise<never> => {
    const left = Math.min(max - used, attemptsLeft ?? Infinity);
    if (left <= 0) {
      await deps.db.set(`otp/${uid}`, kill, true);
      await updateSms(deps.db, d.logId, { outcome: 'locked' }, now);
      throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
    }
    await updateSms(deps.db, d.logId, { outcome: 'wrong_code' }, now);
    throw new HttpError(400, 'invalid_code', 'That code is not correct.', { attemptsLeft: left });
  };

  if (d.route === 'otp' && d.otpId) {
    if (!deps.otp) throw new HttpError(503, 'otp_unavailable', 'Phone verification is not configured on the server yet.');
    try {
      await deps.otp.verify(d.phone, code);
    } catch (err) {
      const c = (err as HttpError).code;
      if (c === 'invalid_code') return wrong((err as HttpError).details?.attemptsLeft as number | undefined);
      if (c === 'expired' || c === 'no_code' || c === 'too_many_attempts') {
        await deps.db.set(`otp/${uid}`, kill, true);
        await updateSms(deps.db, d.logId, { outcome: c === 'expired' ? 'expired' : 'locked' }, now);
      }
      throw err;
    }
  } else if (!d.codeHash || !sameHash(codeKey(deps.secret, uid, d.phone, code), d.codeHash)) {
    return wrong();
  }

  const owner = await deps.db.get<{ uid: string }>(`phoneNumbers/${d.phoneHash}`);
  if (owner && owner.data.uid !== uid) {
    throw new HttpError(409, 'phone_in_use', 'This phone number is already linked to another account.');
  }
  const writes: Write[] = [
    { op: 'set', path: `otp/${uid}`, data: { ...kill, attempts: 0, verifiedPhoneHash: d.phoneHash }, merge: true },
    {
      op: 'set',
      path: `phoneNumbers/${d.phoneHash}`,
      data: { uid, at: new Date(now) },
      precondition: owner?.updateTime ? { updateTime: owner.updateTime } : { exists: false },
    },
  ];
  // Changing number: release the previous one.
  if (d.verifiedPhoneHash && d.verifiedPhoneHash !== d.phoneHash) {
    const prev = await deps.db.get<{ uid: string }>(`phoneNumbers/${d.verifiedPhoneHash}`);
    if (prev?.data.uid === uid) writes.push({ op: 'delete', path: prev.path });
  }
  try {
    await deps.db.commit(writes);
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw new HttpError(409, 'conflict', 'Please try again.');
    throw err;
  }
  await updateSms(deps.db, d.logId, { outcome: 'verified', verifiedAt: now }, now);
  return { phone: d.phone };
}
