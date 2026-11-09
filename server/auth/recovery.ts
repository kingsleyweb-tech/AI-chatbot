/**
 * Password recovery by a one-time code, sent either by SMS (email/password
 * accounts with a verified phone) or by email (email/password accounts with a
 * verified address). An email code is also texted to the account's verified
 * phone, if it has one, so either message can be used.
 *
 * 1. start(email, channel):  uniform response for every email address (no
 *    account enumeration). Only an eligible account actually gets a code, and
 *    only to the number or address already on that account; the caller never
 *    supplies where it goes. Other addresses get an indistinguishable decoy
 *    record whose code can never match. An SMS reset also emails the account
 *    owner that a reset was requested.
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
import { deviceFacts, type ClientInfo } from '../account/devices.js';
import { recordSecurityEvent } from '../account/events.js';
import { sendEmail, type EmailDeps } from '../email/service.js';
import type { AccountAdmin } from '../admin.js';
import type { Firestore, Write } from '../firestore.js';
import { HttpError } from '../http.js';
import { deliveryOf, logSms } from '../sms/log.js';
import { SmsError, type SmsProvider } from '../sms/provider.js';
import { CODE_TTL_MS, MAX_ATTEMPTS, phoneKey, RESEND_MS } from './otp.js';

export const RESET_TTL_MS = 10 * 60_000;
/** email codes live longer than texted ones (mail can take a minute or two) */
export const EMAIL_CODE_MS = 10 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PER_EMAIL_HOUR = 5;
const PER_EMAIL_DAY = 10;
const PER_IP_HOUR = 20;
const PER_PHONE_HOUR = 5;

export type RecoveryChannel = 'sms' | 'email';

export interface RecoveryDeps {
  db: Firestore;
  /** null when SMS is not configured (email codes still work) */
  sms: SmsProvider | null;
  /** email service; codes by email and security notices need it */
  mail?: EmailDeps;
  /** who is asking (device, IP, location) for the notification emails */
  client?: ClientInfo;
  /** run a promise after the response (waitUntil); awaited when absent */
  background?: (p: Promise<unknown>) => void;
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
  channel?: RecoveryChannel;
  phone?: string | null;
  codeHash: string | null;
  expiresAt: number;
  attempts: number;
  createdAt: number;
  resetHash?: string | null;
  resetExpiresAt?: number;
}

const hmac = (secret: string, v: string) => createHmac('sha256', secret).update(v).digest('hex');
const codeKey = (secret: string, rid: string, code: string) =>
  hmac(secret, `recovery|${rid}|${code}`);
const resetKey = (secret: string, rid: string, token: string) =>
  hmac(secret, `reset|${rid}|${token}`);

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

/** Is this account allowed to reset its password with an email code? */
async function eligibleEmail(
  deps: RecoveryDeps,
  email: string,
): Promise<{ uid: string; email: string; name: string | null } | null> {
  const account = await deps.accounts.getByEmail(email);
  // An unverified address may belong to someone else (a typo at sign-up), so it is never a recovery channel.
  if (
    !account?.email ||
    !account.emailVerified ||
    account.disabled ||
    !account.providers.includes('password')
  )
    return null;
  const profile = (await deps.db.get<{ accountStatus?: string }>(`users/${account.uid}`))?.data;
  if ((profile?.accountStatus ?? 'active') !== 'active') return null;
  return { uid: account.uid, email: account.email, name: account.displayName };
}

function later(deps: RecoveryDeps, p: Promise<unknown>) {
  const safe = p.catch((err) =>
    console.warn('[recovery] background email skipped', err instanceof Error ? err.message : err),
  );
  if (deps.background) deps.background(safe);
  return deps.background ? Promise.resolve() : safe;
}

export function recoverySms(code: string, minutes = 5) {
  return `Your Atlas AI password reset code is ${code}. It expires in ${minutes} minutes. If you did not ask to reset your password, ignore this message.`;
}

/**
 * Text the email reset code to the account's verified phone as well, so the
 * person can use whichever arrives first. Same number checks, per-number
 * limit and app-wide daily SMS cap as SMS recovery; logged like any reset
 * text. Never throws.
 */
async function textEmailCode(
  deps: RecoveryDeps,
  target: { uid: string; phone: string },
  code: string,
  now: number,
) {
  const sms = deps.sms;
  if (!sms) return;
  const day = new Date(now).toISOString().slice(0, 10);
  if (((await deps.db.get<{ sent?: number }>(`otpStats/${day}`))?.data.sent ?? 0) >= deps.dailyCap)
    return;
  const pHash = phoneKey(deps.secret, target.phone);
  const perPhone = await deps.db.get<{ sends?: number[] }>(`otpPhones/${pHash}`);
  const phoneSends = (perPhone?.data.sends ?? []).filter((t) => now - t < DAY);
  if (phoneSends.filter((t) => now - t < HOUR).length >= PER_PHONE_HOUR) return;
  await deps.db.commit([
    { op: 'set', path: `otpPhones/${pHash}`, data: { sends: [...phoneSends, now] } },
    { op: 'increment', path: `otpStats/${day}`, increments: { sent: 1 } },
  ]);
  const entry = {
    at: now,
    uid: target.uid,
    purpose: 'recovery' as const,
    route: 'sms' as const,
    phone: target.phone,
  };
  try {
    const r = await sms.send(target.phone, recoverySms(code, EMAIL_CODE_MS / 60_000));
    await logSms(deps.db, {
      ...entry,
      ref: r.id ?? null,
      accepted: true,
      delivery: deliveryOf(r.status),
      providerStatus: r.status ?? 'queued',
    });
  } catch (err) {
    const p =
      err instanceof SmsError
        ? err.provider
        : { message: err instanceof Error ? err.message : String(err) };
    await logSms(deps.db, {
      ...entry,
      ref: null,
      accepted: false,
      delivery: 'failed',
      error: p.message ?? null,
      httpStatus: p.httpStatus ?? null,
      providerStatus: p.code ?? 'rejected',
    }).catch(() => undefined);
  }
}

/** Password rules (same as registration). */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  return null;
}

/** Deterministic fake last digits, so repeated requests for one address look the same. */
async function limit(
  db: Firestore,
  path: string,
  now: number,
  perHour: number,
  perDay: number | null,
  cooldownMs: number | null,
) {
  const doc = await db.get<{ sends?: number[] }>(path);
  const recent = (doc?.data.sends ?? []).filter((t) => now - t < DAY);
  const last = recent.length ? Math.max(...recent) : 0;
  if (cooldownMs && last && now - last < cooldownMs)
    retry(
      'resend_cooldown',
      'Please wait before requesting another code.',
      last + cooldownMs - now,
    );
  if (recent.filter((t) => now - t < HOUR).length >= perHour)
    retry('too_many_codes', 'Too many requests. Try again in an hour.', HOUR);
  if (perDay !== null && recent.length >= perDay)
    retry('too_many_codes', 'Too many requests today. Try again tomorrow.', DAY);
  return { path, sends: [...recent, now] };
}

/** Is this account allowed to recover its password by SMS? Returns its verified number. */
async function eligiblePhone(
  deps: RecoveryDeps,
  email: string,
): Promise<{ uid: string; phone: string } | null> {
  const account = await deps.accounts.getByEmail(email);
  if (
    !account ||
    account.disabled ||
    !account.providers.includes('password') ||
    account.claims.phoneVerified !== true
  )
    return null;
  const profile = (
    await deps.db.get<{
      phoneNumber?: string | null;
      phoneVerified?: boolean;
      accountStatus?: string;
    }>(`users/${account.uid}`)
  )?.data;
  if (
    !profile?.phoneNumber ||
    profile.phoneVerified !== true ||
    (profile.accountStatus ?? 'active') !== 'active'
  )
    return null;
  // The number must still belong to this account.
  const owner = await deps.db.get<{ uid: string }>(
    `phoneNumbers/${phoneKey(deps.secret, profile.phoneNumber)}`,
  );
  if (owner?.data.uid !== account.uid) return null;
  return { uid: account.uid, phone: profile.phoneNumber };
}

export async function startRecovery(
  deps: RecoveryDeps,
  rawEmail: string,
  ip: string,
  channel: RecoveryChannel = 'sms',
) {
  const now = (deps.now ?? Date.now)();
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');

  // Limits keyed by the address and the client, identical for every address.
  const emailLimit = await limit(
    deps.db,
    `rateLimits/re_${hmac(deps.secret, `email|${email}`).slice(0, 40)}`,
    now,
    PER_EMAIL_HOUR,
    PER_EMAIL_DAY,
    RESEND_MS,
  );
  const ipLimit = await limit(
    deps.db,
    `rateLimits/ri_${hmac(deps.secret, `ip|${ip}`).slice(0, 40)}`,
    now,
    PER_IP_HOUR,
    null,
    null,
  );
  if (channel === 'email') return startEmailRecovery(deps, email, now, [emailLimit, ipLimit]);
  if (!deps.sms)
    throw new HttpError(
      503,
      'recovery_unavailable',
      'Password reset by text message is not available right now. Use the email option instead.',
    );
  const day = new Date(now).toISOString().slice(0, 10);
  if (
    ((await deps.db.get<{ sent?: number }>(`otpStats/${day}`))?.data.sent ?? 0) >= deps.dailyCap
  ) {
    throw new HttpError(
      503,
      'sms_daily_cap',
      'Text messages are paused for today. Please try again tomorrow.',
    );
  }

  const rid = randomBytes(24).toString('hex');
  const target = await eligiblePhone(deps, email);
  const writes: Write[] = [
    { op: 'set', path: emailLimit.path, data: { sends: emailLimit.sends } },
    { op: 'set', path: ipLimit.path, data: { sends: ipLimit.sends } },
  ];
  const base = { createdAt: now, expiresAt: now + CODE_TTL_MS, attempts: 0 };
  let send: { to: string; code: string } | null = null;

  if (target) {
    const pHash = phoneKey(deps.secret, target.phone);
    const perPhone = await deps.db.get<{ sends?: number[] }>(`otpPhones/${pHash}`);
    const phoneSends = (perPhone?.data.sends ?? []).filter((t) => now - t < DAY);
    if (phoneSends.filter((t) => now - t < HOUR).length < PER_PHONE_HOUR) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      send = { to: target.phone, code };
      writes.push(
        {
          op: 'set',
          path: `recovery/${rid}`,
          data: {
            ...base,
            uid: target.uid,
            decoy: false,
            channel: 'sms',
            phone: target.phone,
            codeHash: codeKey(deps.secret, rid, code),
          } satisfies RecoveryDoc,
        },
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
    writes.push({
      op: 'set',
      path: `recovery/${rid}`,
      data: {
        ...base,
        uid: null,
        decoy: true,
        codeHash: hmac(deps.secret, randomBytes(16).toString('hex')),
      } satisfies RecoveryDoc,
    });
  }
  await deps.db.commit(writes);

  if (send) {
    const entry = {
      at: now,
      uid: target?.uid ?? null,
      purpose: 'recovery' as const,
      route: 'sms' as const,
      phone: send.to,
    };
    try {
      const r = await deps.sms.send(send.to, recoverySms(send.code));
      await logSms(deps.db, {
        ...entry,
        ref: r.id ?? null,
        accepted: true,
        delivery: deliveryOf(r.status),
        providerStatus: r.status ?? 'queued',
      });
      // Tell the owner by email too (after the response, so timing reveals nothing).
      const account = target ? await deps.accounts.get(target.uid).catch(() => null) : null;
      if (deps.mail && account?.email && account.emailVerified) {
        await later(
          deps,
          sendEmail(deps.mail, {
            type: 'password_reset_requested',
            category: 'critical',
            to: account.email,
            uid: account.uid,
            data: {
              name: account.displayName,
              at: now,
              device: deps.client ? deviceFacts(deps.client) : null,
              timeZone: deps.client?.timeZone,
            },
            dedupeKey: `resetreq|${account.uid}`,
            dedupeMs: 15 * 60_000,
          }),
        );
      }
    } catch (err) {
      await deps.db.set(`recovery/${rid}`, { codeHash: null }, true).catch(() => undefined);
      const p =
        err instanceof SmsError
          ? err.provider
          : { message: err instanceof Error ? err.message : String(err) };
      await logSms(deps.db, {
        ...entry,
        ref: null,
        accepted: false,
        delivery: 'failed',
        error: p.message ?? null,
        httpStatus: p.httpStatus ?? null,
        providerStatus: p.code ?? 'rejected',
      });
      console.error('[recovery] SMS delivery failed', err instanceof Error ? err.message : err);
    }
  } else if (deps.decoyDelayMs !== 0) {
    await new Promise((r) => setTimeout(r, (deps.decoyDelayMs ?? 400) + randomInt(0, 400)));
  }
  // No number is returned, real or made up: the answer is identical for every address, so it
  // reveals nothing, and nobody is shown a number that is not theirs (the old decoy confused
  // people whose account cannot use text-message reset, such as Google sign-ins).
  return {
    recoveryId: rid,
    phoneMasked: null,
    expiresIn: CODE_TTL_MS / 1000,
    resendIn: RESEND_MS / 1000,
  };
}

/** Email channel of startRecovery: same limits, decoys and response shape as SMS. */
async function startEmailRecovery(
  deps: RecoveryDeps,
  email: string,
  now: number,
  limits: { path: string; sends: number[] }[],
) {
  if (!deps.mail?.provider)
    throw new HttpError(
      503,
      'recovery_unavailable',
      'Password reset by email code is not available right now. Use the text message option instead.',
    );
  const rid = randomBytes(24).toString('hex');
  const target = await eligibleEmail(deps, email);
  const base = {
    createdAt: now,
    expiresAt: now + EMAIL_CODE_MS,
    attempts: 0,
    channel: 'email' as const,
  };
  const writes: Write[] = limits.map((l) => ({
    op: 'set' as const,
    path: l.path,
    data: { sends: l.sends },
  }));
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  if (target) {
    writes.push(
      {
        op: 'set',
        path: `recovery/${rid}`,
        data: {
          ...base,
          uid: target.uid,
          decoy: false,
          codeHash: codeKey(deps.secret, rid, code),
        } satisfies RecoveryDoc,
      },
      { op: 'set', path: `otpRecovery/${target.uid}`, data: { activeId: rid, at: now } },
    );
  } else {
    writes.push({
      op: 'set',
      path: `recovery/${rid}`,
      data: {
        ...base,
        uid: null,
        decoy: true,
        codeHash: hmac(deps.secret, randomBytes(16).toString('hex')),
      } satisfies RecoveryDoc,
    });
  }
  await deps.db.commit(writes);
  if (target) {
    // The same code also goes by SMS when the account has a verified phone.
    const phone = deps.sms ? await eligiblePhone(deps, email) : null;
    const texted = phone?.uid === target.uid ? phone : null;
    if (texted) await later(deps, textEmailCode(deps, texted, code, now));
    const r = await sendEmail(deps.mail, {
      type: 'password_reset_code',
      category: 'critical',
      to: target.email,
      uid: target.uid,
      data: {
        name: target.name,
        code,
        minutes: EMAIL_CODE_MS / 60_000,
        timeZone: deps.client?.timeZone,
      },
    });
    // An undelivered code is voided, unless it was texted too.
    if (!r.sent && !texted)
      await deps.db.set(`recovery/${rid}`, { codeHash: null }, true).catch(() => undefined);
  } else if (deps.decoyDelayMs !== 0) {
    await new Promise((r) => setTimeout(r, (deps.decoyDelayMs ?? 600) + randomInt(0, 500)));
  }
  return {
    recoveryId: rid,
    phoneMasked: null,
    expiresIn: EMAIL_CODE_MS / 1000,
    resendIn: RESEND_MS / 1000,
  };
}

export async function verifyRecovery(
  deps: RecoveryDeps,
  rid: string,
  code: string,
): Promise<{ resetToken: string }> {
  const now = (deps.now ?? Date.now)();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'bad_code', 'Enter the 6-digit code.');
  if (!/^[a-f0-9]{48}$/.test(rid))
    throw new HttpError(400, 'no_code', 'This reset request is not valid. Start again.');
  const cur = await deps.db.get<RecoveryDoc>(`recovery/${rid}`);
  const d = cur?.data;
  if (!cur || !d?.codeHash)
    throw new HttpError(400, 'no_code', 'There is no active code. Request a new one.');
  if (d.expiresAt <= now)
    throw new HttpError(400, 'expired', 'This code has expired. Request a new one.');
  if (d.attempts >= MAX_ATTEMPTS)
    throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
  const pre = { updateTime: cur.updateTime ?? '' };

  // An older request is replaced by a newer one for the same account.
  let current = true;
  if (d.uid)
    current =
      (await deps.db.get<{ activeId?: string }>(`otpRecovery/${d.uid}`))?.data.activeId === rid;

  if (!current || d.decoy || !same(codeKey(deps.secret, rid, code), d.codeHash)) {
    const used = d.attempts + 1;
    try {
      await deps.db.commit([
        {
          op: 'set',
          path: cur.path,
          data: { attempts: used, ...(used >= MAX_ATTEMPTS ? { codeHash: null } : {}) },
          merge: true,
          precondition: pre,
        },
      ]);
    } catch (err) {
      if ((err as { status?: number }).status === 409)
        throw new HttpError(409, 'conflict', 'Please try again.');
      throw err;
    }
    if (used >= MAX_ATTEMPTS)
      throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
    throw new HttpError(400, 'invalid_code', 'That code is not correct.', {
      attemptsLeft: MAX_ATTEMPTS - used,
    });
  }

  const resetToken = randomBytes(32).toString('base64url');
  try {
    await deps.db.commit([
      {
        op: 'set',
        path: cur.path,
        data: {
          codeHash: null,
          resetHash: resetKey(deps.secret, rid, resetToken),
          resetExpiresAt: now + RESET_TTL_MS,
        },
        merge: true,
        precondition: pre,
      },
    ]);
  } catch (err) {
    if ((err as { status?: number }).status === 409)
      throw new HttpError(409, 'conflict', 'Please try again.');
    throw err;
  }
  return { resetToken };
}

export async function resetPassword(
  deps: RecoveryDeps,
  rid: string,
  token: string,
  password: string,
  device: string,
) {
  const now = (deps.now ?? Date.now)();
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, 'weak_password', problem);
  if (!/^[a-f0-9]{48}$/.test(rid) || !token)
    throw new HttpError(400, 'reset_invalid', 'This reset link is not valid. Start again.');
  const cur = await deps.db.get<RecoveryDoc>(`recovery/${rid}`);
  const d = cur?.data;
  if (
    !cur ||
    !d?.uid ||
    d.decoy ||
    !d.resetHash ||
    !same(resetKey(deps.secret, rid, token), d.resetHash)
  ) {
    throw new HttpError(400, 'reset_invalid', 'This reset request is not valid. Start again.');
  }
  if ((d.resetExpiresAt ?? 0) <= now)
    throw new HttpError(400, 'reset_expired', 'This reset request has expired. Start again.');
  const account = await deps.accounts.get(d.uid);
  if (!account || account.disabled || !account.providers.includes('password')) {
    throw new HttpError(
      400,
      'reset_invalid',
      'This account cannot be reset. Contact the administrator.',
    );
  }
  // Consume first: a token can change the password at most once, even with parallel requests.
  try {
    await deps.db.commit([
      { op: 'delete', path: cur.path, precondition: { updateTime: cur.updateTime ?? '' } },
      { op: 'delete', path: `otpRecovery/${d.uid}` },
    ]);
  } catch (err) {
    if ((err as { status?: number }).status === 409)
      throw new HttpError(400, 'reset_invalid', 'This reset request was already used.');
    throw err;
  }
  await deps.accounts.update(d.uid, { password, revokeSessions: true });
  // Cut off ID tokens that are still valid (the rules compare auth_time with this).
  await deps.db.set(`users/${d.uid}`, { sessionsValidAfter: Math.floor(now / 1000) }, true);
  const how = d.channel === 'email' ? 'Reset with an email code' : 'Reset with a text-message code';
  await recordSecurityEvent(
    deps.db,
    d.uid,
    'password_reset',
    { provider: 'password', device, detail: how },
    now,
  );
  if (deps.mail && account.email && account.emailVerified) {
    await later(
      deps,
      sendEmail(deps.mail, {
        type: 'password_changed',
        category: 'critical',
        to: account.email,
        uid: account.uid,
        data: {
          name: account.displayName,
          reason: how.toLowerCase(),
          at: now,
          device: deps.client ? deviceFacts(deps.client) : null,
          timeZone: deps.client?.timeZone,
        },
      }),
    );
  }
}

/**
 * Best-effort record of a failed password sign-in reported by the sign-in
 * page (Firebase checks passwords itself, so attempts made directly against
 * its API are not visible here). Rate limited per address; silent for
 * unknown addresses.
 */
/** Failed password attempts within an hour that trigger one warning email. */
export const FAILED_LOGIN_ALERT = 5;

export async function recordFailedLogin(
  deps: Pick<RecoveryDeps, 'db' | 'accounts' | 'secret' | 'now' | 'mail' | 'client' | 'background'>,
  rawEmail: string,
  device: string,
) {
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
  await recordSecurityEvent(
    deps.db,
    account.uid,
    'login_failed',
    { provider: 'password', device, by: 'system' },
    now,
  );
  const count = recent.length + 1;
  if (count === FAILED_LOGIN_ALERT && deps.mail && account.email && account.emailVerified) {
    await later(
      deps as RecoveryDeps,
      sendEmail(deps.mail, {
        type: 'failed_logins',
        category: 'suspicious',
        to: account.email,
        uid: account.uid,
        data: {
          name: account.displayName,
          count,
          at: now,
          device: deps.client ? deviceFacts(deps.client) : null,
          timeZone: deps.client?.timeZone,
        },
        dedupeKey: `failed|${account.uid}`,
        dedupeMs: HOUR,
      }),
    );
  }
}
