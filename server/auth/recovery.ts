/**
 * Password recovery by SMS for email/password accounts with a verified phone.
 *
 * 1. start(email):  uniform response for every email address (no account
 *    enumeration). Only an eligible account (password sign-in, verified phone
 *    that it still owns, active, not disabled) actually gets a text, and only
 *    to the number already verified on that account; the caller never
 *    supplies a phone number. Other addresses get an indistinguishable decoy
 *    record whose code can never match.
 * 2. verify(recoveryId, code): 6-digit code, 5 minutes, single use, 5
 *    attempts (counted atomically). Success returns a one-time reset token
 *    (10 minutes) bound to that recovery record.
 * 3. reset(recoveryId, token, password): consumes the token first (atomic
 *    delete with precondition), then sets the password through the Firebase
 *    Auth admin API and revokes every existing session.
 *
 * Records live in server-only collections (recovery, otpRecovery,
 * rateLimits); codes and tokens are stored only as HMACs.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { recordSecurityEvent } from '../account/events.js';
import type { AccountAdmin } from '../admin.js';
import type { Firestore, Write } from '../firestore.js';
import { HttpError } from '../http.js';
import { deliveryOf, logSms } from '../sms/log.js';
import { SmsError, type SmsProvider } from '../sms/provider.js';
import { CODE_TTL_MS, MAX_ATTEMPTS, phoneKey, RESEND_MS } from './otp.js';
import { maskPhone } from './phone.js';

export const RESET_TTL_MS = 10 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PER_EMAIL_HOUR = 5;
const PER_EMAIL_DAY = 10;
const PER_IP_HOUR = 20;
const PER_PHONE_HOUR = 5;

export interface RecoveryDeps {
  db: Firestore;
  sms: SmsProvider;
  accounts: AccountAdmin;
  secret: string;
  dailyCap: number;
  now?: () => number;
  /** artificial delay for decoys so timing does not reveal account existence (tests pass 0) */
  decoyDelayMs?: number;
}

interface RecoveryDoc {
  uid: string | null;
  decoy: boolean;
  phone?: string | null;
  codeHash: string | null;
  expiresAt: number;
  attempts: number;
  createdAt: number;
  resetHash?: string | null;
  resetExpiresAt?: number;
}

const hmac = (secret: string, v: string) => createHmac('sha256', secret).update(v).digest('hex');
const codeKey = (secret: string, rid: string, code: string) => hmac(secret, `recovery|${rid}|${code}`);
const resetKey = (secret: string, rid: string, token: string) => hmac(secret, `reset|${rid}|${token}`);

function same(a: string, b: string) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function retry(code: string, message: string, ms: number): never {
  throw new HttpError(429, code, message, { retryAfter: Math.max(1, Math.ceil(ms / 1000)) });
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function recoverySms(code: string) {
  return `Your Atlas AI password reset code is ${code}. It expires in 5 minutes. If you did not ask to reset your password, ignore this message.`;
}

/** Password rules (same as registration). */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  return null;
}

/** Deterministic fake last digits, so repeated requests for one address look the same. */
function decoyMask(secret: string, email: string) {
  const digits = String(parseInt(hmac(secret, `decoy|${email}`).slice(0, 8), 16) % 10000).padStart(4, '0');
  return `+233 •• ••• ${digits}`;
}

async function limit(db: Firestore, path: string, now: number, perHour: number, perDay: number | null, cooldownMs: number | null) {
  const doc = await db.get<{ sends?: number[] }>(path);
  const recent = (doc?.data.sends ?? []).filter((t) => now - t < DAY);
  const last = recent.length ? Math.max(...recent) : 0;
  if (cooldownMs && last && now - last < cooldownMs) retry('resend_cooldown', 'Please wait before requesting another code.', last + cooldownMs - now);
  if (recent.filter((t) => now - t < HOUR).length >= perHour) retry('too_many_codes', 'Too many requests. Try again in an hour.', HOUR);
  if (perDay !== null && recent.length >= perDay) retry('too_many_codes', 'Too many requests today. Try again tomorrow.', DAY);
  return { path, sends: [...recent, now] };
}

/** Is this account allowed to recover its password by SMS? Returns its verified number. */
async function eligiblePhone(deps: RecoveryDeps, email: string): Promise<{ uid: string; phone: string } | null> {
  const account = await deps.accounts.getByEmail(email);
  if (!account || account.disabled || !account.providers.includes('password') || account.claims.phoneVerified !== true) return null;
  const profile = (await deps.db.get<{ phoneNumber?: string | null; phoneVerified?: boolean; accountStatus?: string }>(`users/${account.uid}`))?.data;
  if (!profile?.phoneNumber || profile.phoneVerified !== true || (profile.accountStatus ?? 'active') !== 'active') return null;
  // The number must still belong to this account.
  const owner = await deps.db.get<{ uid: string }>(`phoneNumbers/${phoneKey(deps.secret, profile.phoneNumber)}`);
  if (owner?.data.uid !== account.uid) return null;
  return { uid: account.uid, phone: profile.phoneNumber };
}

export async function startRecovery(deps: RecoveryDeps, rawEmail: string, ip: string) {
  const now = (deps.now ?? Date.now)();
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');

  // Limits keyed by the address and the client, identical for every address.
  const emailLimit = await limit(deps.db, `rateLimits/re_${hmac(deps.secret, `email|${email}`).slice(0, 40)}`, now, PER_EMAIL_HOUR, PER_EMAIL_DAY, RESEND_MS);
  const ipLimit = await limit(deps.db, `rateLimits/ri_${hmac(deps.secret, `ip|${ip}`).slice(0, 40)}`, now, PER_IP_HOUR, null, null);
  const day = new Date(now).toISOString().slice(0, 10);
  if (((await deps.db.get<{ sent?: number }>(`otpStats/${day}`))?.data.sent ?? 0) >= deps.dailyCap) {
    throw new HttpError(503, 'sms_daily_cap', 'Text messages are paused for today. Please try again tomorrow.');
  }

  const rid = randomBytes(24).toString('hex');
  const target = await eligiblePhone(deps, email);
  const writes: Write[] = [
    { op: 'set', path: emailLimit.path, data: { sends: emailLimit.sends } },
    { op: 'set', path: ipLimit.path, data: { sends: ipLimit.sends } },
  ];
  const base = { createdAt: now, expiresAt: now + CODE_TTL_MS, attempts: 0 };
  let phoneMasked = decoyMask(deps.secret, email);
  let send: { to: string; code: string } | null = null;

  if (target) {
    const pHash = phoneKey(deps.secret, target.phone);
    const perPhone = await deps.db.get<{ sends?: number[] }>(`otpPhones/${pHash}`);
    const phoneSends = (perPhone?.data.sends ?? []).filter((t) => now - t < DAY);
    phoneMasked = maskPhone(target.phone);
    if (phoneSends.filter((t) => now - t < HOUR).length < PER_PHONE_HOUR) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      send = { to: target.phone, code };
      writes.push(
        { op: 'set', path: `recovery/${rid}`, data: { ...base, uid: target.uid, decoy: false, phone: target.phone, codeHash: codeKey(deps.secret, rid, code) } satisfies RecoveryDoc },
        { op: 'set', path: `otpRecovery/${target.uid}`, data: { activeId: rid, at: now } },
        { op: 'set', path: `otpPhones/${pHash}`, data: { sends: [...phoneSends, now] } },
        { op: 'increment', path: `otpStats/${day}`, increments: { sent: 1 } },
      );
    } else {
      console.warn('[recovery] per-number limit reached; no text sent');
    }
  }
  if (!send) {
    // Same shape as a real record; its code hash can never match.
    writes.push({ op: 'set', path: `recovery/${rid}`, data: { ...base, uid: null, decoy: true, codeHash: hmac(deps.secret, randomBytes(16).toString('hex')) } satisfies RecoveryDoc });
  }
  await deps.db.commit(writes);

  if (send) {
    const entry = { at: now, uid: target?.uid ?? null, purpose: 'recovery' as const, route: 'sms' as const, phone: send.to };
    try {
      const r = await deps.sms.send(send.to, recoverySms(send.code));
      await logSms(deps.db, { ...entry, ref: r.id ?? null, accepted: true, delivery: deliveryOf(r.status), providerStatus: r.status ?? 'queued' });
    } catch (err) {
      await deps.db.set(`recovery/${rid}`, { codeHash: null }, true).catch(() => undefined);
      const p = err instanceof SmsError ? err.provider : { message: err instanceof Error ? err.message : String(err) };
      await logSms(deps.db, { ...entry, ref: null, accepted: false, delivery: 'failed', error: p.message ?? null, httpStatus: p.httpStatus ?? null, providerStatus: p.code ?? 'rejected' });
      console.error('[recovery] SMS delivery failed', err instanceof Error ? err.message : err);
    }
  } else if (deps.decoyDelayMs !== 0) {
    await new Promise((r) => setTimeout(r, (deps.decoyDelayMs ?? 400) + randomInt(0, 400)));
  }
  return { recoveryId: rid, phoneMasked, expiresIn: CODE_TTL_MS / 1000, resendIn: RESEND_MS / 1000 };
}

export async function verifyRecovery(deps: RecoveryDeps, rid: string, code: string): Promise<{ resetToken: string }> {
  const now = (deps.now ?? Date.now)();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'bad_code', 'Enter the 6-digit code.');
  if (!/^[a-f0-9]{48}$/.test(rid)) throw new HttpError(400, 'no_code', 'This reset request is not valid. Start again.');
  const cur = await deps.db.get<RecoveryDoc>(`recovery/${rid}`);
  const d = cur?.data;
  if (!cur || !d?.codeHash) throw new HttpError(400, 'no_code', 'There is no active code. Request a new one.');
  if (d.expiresAt <= now) throw new HttpError(400, 'expired', 'This code has expired. Request a new one.');
  if (d.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
  const pre = { updateTime: cur.updateTime ?? '' };

  // An older request is replaced by a newer one for the same account.
  let current = true;
  if (d.uid) current = (await deps.db.get<{ activeId?: string }>(`otpRecovery/${d.uid}`))?.data.activeId === rid;

  if (!current || d.decoy || !same(codeKey(deps.secret, rid, code), d.codeHash)) {
    const used = d.attempts + 1;
    try {
      await deps.db.commit([{ op: 'set', path: cur.path, data: { attempts: used, ...(used >= MAX_ATTEMPTS ? { codeHash: null } : {}) }, merge: true, precondition: pre }]);
    } catch (err) {
      if ((err as { status?: number }).status === 409) throw new HttpError(409, 'conflict', 'Please try again.');
      throw err;
    }
    if (used >= MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
    throw new HttpError(400, 'invalid_code', 'That code is not correct.', { attemptsLeft: MAX_ATTEMPTS - used });
  }

  const resetToken = randomBytes(32).toString('base64url');
  try {
    await deps.db.commit([
      {
        op: 'set',
        path: cur.path,
        data: { codeHash: null, resetHash: resetKey(deps.secret, rid, resetToken), resetExpiresAt: now + RESET_TTL_MS },
        merge: true,
        precondition: pre,
      },
    ]);
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw new HttpError(409, 'conflict', 'Please try again.');
    throw err;
  }
  return { resetToken };
}

export async function resetPassword(deps: RecoveryDeps, rid: string, token: string, password: string, device: string) {
  const now = (deps.now ?? Date.now)();
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, 'weak_password', problem);
  if (!/^[a-f0-9]{48}$/.test(rid) || !token) throw new HttpError(400, 'reset_invalid', 'This reset link is not valid. Start again.');
  const cur = await deps.db.get<RecoveryDoc>(`recovery/${rid}`);
  const d = cur?.data;
  if (!cur || !d?.uid || d.decoy || !d.resetHash || !same(resetKey(deps.secret, rid, token), d.resetHash)) {
    throw new HttpError(400, 'reset_invalid', 'This reset request is not valid. Start again.');
  }
  if ((d.resetExpiresAt ?? 0) <= now) throw new HttpError(400, 'reset_expired', 'This reset request has expired. Start again.');
  const account = await deps.accounts.get(d.uid);
  if (!account || account.disabled || !account.providers.includes('password')) {
    throw new HttpError(400, 'reset_invalid', 'This account cannot be reset. Contact the administrator.');
  }
  // Consume first: a token can change the password at most once, even with parallel requests.
  try {
    await deps.db.commit([
      { op: 'delete', path: cur.path, precondition: { updateTime: cur.updateTime ?? '' } },
      { op: 'delete', path: `otpRecovery/${d.uid}` },
    ]);
  } catch (err) {
    if ((err as { status?: number }).status === 409) throw new HttpError(400, 'reset_invalid', 'This reset request was already used.');
    throw err;
  }
  await deps.accounts.update(d.uid, { password, revokeSessions: true });
  // Cut off ID tokens that are still valid (the rules compare auth_time with this).
  await deps.db.set(`users/${d.uid}`, { sessionsValidAfter: Math.floor(now / 1000) }, true);
  await recordSecurityEvent(deps.db, d.uid, 'password_reset', { provider: 'password', device, detail: 'Reset with a text-message code' }, now);
}

/**
 * Best-effort record of a failed password sign-in reported by the sign-in
 * page (Firebase checks passwords itself, so attempts made directly against
 * its API are not visible here). Rate limited per address; silent for
 * unknown addresses.
 */
export async function recordFailedLogin(deps: Pick<RecoveryDeps, 'db' | 'accounts' | 'secret' | 'now'>, rawEmail: string, device: string) {
  const now = (deps.now ?? Date.now)();
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return;
  const path = `rateLimits/fl_${hmac(deps.secret, `email|${email}`).slice(0, 40)}`;
  const doc = await deps.db.get<{ sends?: number[] }>(path);
  const recent = (doc?.data.sends ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= 10) return;
  await deps.db.set(path, { sends: [...recent, now] });
  const account = await deps.accounts.getByEmail(email);
  if (!account) return;
  await recordSecurityEvent(deps.db, account.uid, 'login_failed', { provider: 'password', device, by: 'system' }, now);
}
