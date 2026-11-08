/**
 * One-time SMS codes for email/password accounts.
 *
 * - 6 digits from crypto.randomInt, valid 5 minutes, single use.
 * - Only an HMAC of the code is stored, in server-only documents
 *   (otp/{uid}; the security rules deny all client access).
 * - 60 s resend cooldown; at most 5 codes per hour and 10 per day per account
 *   and per phone number; an app-wide daily cap protects the SMS balance.
 * - 5 wrong attempts invalidate a code. Attempts are counted with an
 *   optimistic-concurrency precondition, so parallel guesses cannot skip the count.
 * - A phone number can verify only one account (phoneNumbers/{hash}).
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Firestore, Write } from '../firestore.js';
import { HttpError } from '../http.js';
import type { SmsProvider } from '../sms/provider.js';
import { maskPhone, normalizePhone } from './phone.js';

export const CODE_TTL_MS = 5 * 60_000;
export const RESEND_MS = 60_000;
export const MAX_ATTEMPTS = 5;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PER_HOUR = 5;
const PER_DAY = 10;

export interface OtpDeps {
  db: Firestore;
  sms: SmsProvider;
  secret: string;
  dailyCap: number;
  now?: () => number;
}

interface OtpDoc {
  phone?: string;
  phoneHash?: string;
  codeHash?: string | null;
  expiresAt?: number;
  attempts?: number;
  sentAt?: number;
  sends?: number[];
  verifiedPhoneHash?: string | null;
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

function tooMany(code: string, message: string, retryAfter: number): never {
  throw new HttpError(429, code, message, { retryAfter: Math.max(1, Math.ceil(retryAfter / 1000)) });
}

export function smsText(code: string) {
  return `Your Atlas AI verification code is ${code}. It expires in 5 minutes. Do not share it.`;
}

/** Status for the verification screen. Never includes the code or its hash. */
export async function otpStatus(deps: OtpDeps, uid: string) {
  const now = (deps.now ?? Date.now)();
  const d = (await deps.db.get<OtpDoc>(`otp/${uid}`))?.data;
  const active = Boolean(d?.codeHash && (d.expiresAt ?? 0) > now);
  return {
    pending: active,
    phoneMasked: active && d?.phone ? maskPhone(d.phone) : null,
    expiresIn: active ? Math.ceil(((d?.expiresAt ?? 0) - now) / 1000) : 0,
    resendIn: d?.sentAt ? Math.max(0, Math.ceil((d.sentAt + RESEND_MS - now) / 1000)) : 0,
    attemptsLeft: active ? MAX_ATTEMPTS - (d?.attempts ?? 0) : MAX_ATTEMPTS,
  };
}

export async function sendCode(deps: OtpDeps, uid: string, rawPhone: string) {
  const now = (deps.now ?? Date.now)();
  const phone = normalizePhone(rawPhone);
  if (!phone.ok) {
    throw phone.reason === 'country'
      ? new HttpError(400, 'unsupported_country', 'Only Ghana (+233) mobile numbers are supported at the moment.')
      : new HttpError(400, 'invalid_phone', 'Enter a valid mobile number, for example 024 123 4567.');
  }
  const e164 = phone.e164;
  const pHash = phoneKey(deps.secret, e164);
  const day = new Date(now).toISOString().slice(0, 10);

  const [owner, cur, perPhone, stats] = await Promise.all([
    deps.db.get<{ uid: string }>(`phoneNumbers/${pHash}`),
    deps.db.get<OtpDoc>(`otp/${uid}`),
    deps.db.get<{ sends?: number[] }>(`otpPhones/${pHash}`),
    deps.db.get<{ sent?: number }>(`otpStats/${day}`),
  ]);
  if (owner && owner.data.uid !== uid) {
    throw new HttpError(409, 'phone_in_use', 'This phone number is already linked to another account.');
  }
  const d = cur?.data ?? {};
  if (d.sentAt && now - d.sentAt < RESEND_MS) {
    tooMany('resend_cooldown', 'Please wait before requesting another code.', d.sentAt + RESEND_MS - now);
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

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // Reserve the send (counts toward limits even if delivery fails) before texting.
  const writes: Write[] = [
    {
      op: 'set',
      path: `otp/${uid}`,
      data: {
        ...d,
        phone: e164,
        phoneHash: pHash,
        codeHash: codeKey(deps.secret, uid, e164, code),
        expiresAt: now + CODE_TTL_MS,
        attempts: 0,
        sentAt: now,
        sends: [...mine.recent, now],
      },
      precondition: cur?.updateTime ? { updateTime: cur.updateTime } : { exists: false },
    },
    { op: 'set', path: `otpPhones/${pHash}`, data: { sends: [...theirs.recent, now] } },
    { op: 'increment', path: `otpStats/${day}`, increments: { sent: 1 } },
  ];
  try {
    await deps.db.commit(writes);
  } catch (err) {
    // Another request changed the record between read and write (a parallel send).
    if ((err as { status?: number }).status === 409) tooMany('resend_cooldown', 'A code was just sent. Please wait.', RESEND_MS);
    throw err;
  }
  try {
    await deps.sms.send(e164, smsText(code));
  } catch (err) {
    // Delivery failed: drop the code and allow an immediate retry (limits still apply).
    await deps.db.set(`otp/${uid}`, { codeHash: null, sentAt: 0 }, true).catch(() => undefined);
    throw err;
  }
  return { phoneMasked: maskPhone(e164), expiresIn: CODE_TTL_MS / 1000, resendIn: RESEND_MS / 1000 };
}

/** Checks the code; on success the phone is bound to the account and the code is consumed. */
export async function verifyCode(deps: OtpDeps, uid: string, code: string): Promise<{ phone: string }> {
  const now = (deps.now ?? Date.now)();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'bad_code', 'Enter the 6-digit code.');
  const cur = await deps.db.get<OtpDoc>(`otp/${uid}`);
  const d = cur?.data;
  if (!cur || !d?.codeHash || !d.phone || !d.phoneHash) {
    throw new HttpError(400, 'no_code', 'There is no active code. Request a new one.');
  }
  if ((d.expiresAt ?? 0) <= now) throw new HttpError(400, 'expired', 'This code has expired. Request a new one.');
  const attempts = d.attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
  const pre = { updateTime: cur.updateTime ?? '' };

  if (!sameHash(codeKey(deps.secret, uid, d.phone, code), d.codeHash)) {
    const used = attempts + 1;
    try {
      await deps.db.commit([
        {
          op: 'set',
          path: `otp/${uid}`,
          data: { attempts: used, ...(used >= MAX_ATTEMPTS ? { codeHash: null } : {}) },
          merge: true,
          precondition: pre,
        },
      ]);
    } catch (err) {
      if ((err as { status?: number }).status === 409) throw new HttpError(409, 'conflict', 'Please try again.');
      throw err;
    }
    if (used >= MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
    throw new HttpError(400, 'invalid_code', 'That code is not correct.', { attemptsLeft: MAX_ATTEMPTS - used });
  }

  const owner = await deps.db.get<{ uid: string }>(`phoneNumbers/${d.phoneHash}`);
  if (owner && owner.data.uid !== uid) {
    throw new HttpError(409, 'phone_in_use', 'This phone number is already linked to another account.');
  }
  const writes: Write[] = [
    { op: 'set', path: `otp/${uid}`, data: { codeHash: null, attempts: 0, verifiedPhoneHash: d.phoneHash }, merge: true, precondition: pre },
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
  return { phone: d.phone };
}
