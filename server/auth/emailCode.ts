/**
 * One-time codes sent by email to a signed-in person's own address (the one
 * on the Firebase account, never an address from the request).
 *
 * Purposes:
 * - verify_email  verify the account's email address with a code instead of
 *                 (or as well as) Firebase's link; success marks the Firebase
 *                 account as verified through the admin API
 * - sensitive     confirm a sensitive action; success grants a 10-minute
 *                 step-up window checked with hasRecentStepUp()
 *
 * Codes: 6 digits from crypto.randomInt, stored only as an HMAC bound to the
 * account, purpose and request id; 10 minutes; single use; 5 wrong attempts;
 * a new code replaces the previous one; 60 s between sends, 5 per hour and
 * 10 per day per account and purpose. Never returned, never logged.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AccountAdmin } from '../admin.js';
import { sendEmail, type EmailDeps } from '../email/service.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';

export type EmailCodePurpose = 'verify_email' | 'sensitive';

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_RESEND_MS = 60_000;
export const EMAIL_MAX_ATTEMPTS = 5;
export const STEP_UP_MS = 10 * 60_000;
const PER_HOUR = 5;
const PER_DAY = 10;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface EmailCodeDeps {
  db: Firestore;
  accounts: AccountAdmin;
  mail: EmailDeps;
  secret: string;
  now?: () => number;
}

interface CodeDoc {
  rid: string;
  codeHash: string | null;
  expiresAt: number;
  attempts: number;
  sends: number[];
  stepUpUntil?: number | null;
}

const path = (uid: string, purpose: EmailCodePurpose) => `emailCodes/${uid}_${purpose}`;
const codeKey = (secret: string, uid: string, purpose: string, rid: string, code: string) => createHmac('sha256', secret).update(`email|${uid}|${purpose}|${rid}|${code}`).digest('hex');

function same(a: string, b: string) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function retry(code: string, message: string, ms: number): never {
  throw new HttpError(429, code, message, { retryAfter: Math.max(1, Math.ceil(ms / 1000)) });
}

const PURPOSE_TEXT: Record<EmailCodePurpose, string> = { verify_email: 'verify your email address', sensitive: 'confirm a sensitive change to your account' };

export async function sendEmailCode(deps: EmailCodeDeps, user: { uid: string; email: string | null; name?: string | null }, purpose: EmailCodePurpose, timeZone?: string | null) {
  const now = (deps.now ?? Date.now)();
  if (!deps.mail.provider) throw new HttpError(503, 'email_unavailable', 'Email codes are not available right now.');
  const account = await deps.accounts.get(user.uid);
  const email = account?.email ?? user.email;
  if (!account || account.disabled || !email) throw new HttpError(400, 'no_email', 'This account has no email address.');
  if (purpose === 'verify_email' && account.emailVerified) throw new HttpError(400, 'already_verified', 'Your email address is already verified.');

  const cur = await deps.db.get<CodeDoc>(path(user.uid, purpose));
  const sends = (cur?.data.sends ?? []).filter((t) => now - t < DAY);
  const last = sends.length ? Math.max(...sends) : 0;
  if (last && now - last < EMAIL_RESEND_MS) retry('resend_cooldown', 'Please wait before requesting another code.', last + EMAIL_RESEND_MS - now);
  if (sends.filter((t) => now - t < HOUR).length >= PER_HOUR) retry('too_many_codes', 'Too many codes requested. Try again in an hour.', HOUR);
  if (sends.length >= PER_DAY) retry('too_many_codes', 'Too many codes requested today. Try again tomorrow.', DAY);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const rid = randomBytes(12).toString('hex');
  // Replaces any earlier code: only the newest one can match.
  await deps.db.set(path(user.uid, purpose), {
    rid,
    codeHash: codeKey(deps.secret, user.uid, purpose, rid, code),
    expiresAt: now + EMAIL_CODE_TTL_MS,
    attempts: 0,
    sends: [...sends, now],
    stepUpUntil: cur?.data.stepUpUntil ?? null,
  } satisfies CodeDoc);

  const r = await sendEmail(deps.mail, {
    type: purpose === 'verify_email' ? 'verify_email' : 'otp',
    category: 'critical',
    to: email,
    uid: user.uid,
    data: { name: user.name ?? account.displayName, code, minutes: EMAIL_CODE_TTL_MS / 60_000, purpose: PURPOSE_TEXT[purpose], timeZone },
  });
  if (!r.sent) {
    // The code was never delivered: void it so it cannot be guessed at.
    await deps.db.set(path(user.uid, purpose), { codeHash: null }, true).catch(() => undefined);
    throw new HttpError(503, 'email_failed', 'The email could not be sent. Please try again in a moment.');
  }
  const [name, domain] = email.split('@');
  return { sentTo: `${name!.slice(0, 2)}•••@${domain}`, expiresIn: EMAIL_CODE_TTL_MS / 1000, resendIn: EMAIL_RESEND_MS / 1000 };
}

export async function verifyEmailCode(deps: EmailCodeDeps, uid: string, purpose: EmailCodePurpose, code: string) {
  const now = (deps.now ?? Date.now)();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'bad_code', 'Enter the 6-digit code.');
  const cur = await deps.db.get<CodeDoc>(path(uid, purpose));
  const d = cur?.data;
  if (!cur || !d?.codeHash) throw new HttpError(400, 'no_code', 'There is no active code. Request a new one.');
  if (d.expiresAt <= now) throw new HttpError(400, 'expired', 'This code has expired. Request a new one.');
  if (d.attempts >= EMAIL_MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
  const pre = { updateTime: cur.updateTime ?? '' };
  const conflict = (err: unknown) => {
    if ((err as { status?: number }).status === 409) throw new HttpError(409, 'conflict', 'Please try again.');
    throw err;
  };

  if (!same(codeKey(deps.secret, uid, purpose, d.rid, code), d.codeHash)) {
    const used = d.attempts + 1;
    await deps.db
      .commit([{ op: 'set', path: cur.path, data: { attempts: used, ...(used >= EMAIL_MAX_ATTEMPTS ? { codeHash: null } : {}) }, merge: true, precondition: pre }])
      .catch(conflict);
    if (used >= EMAIL_MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.');
    throw new HttpError(400, 'invalid_code', 'That code is not correct.', { attemptsLeft: EMAIL_MAX_ATTEMPTS - used });
  }

  // Consume it (single use, even with parallel requests).
  await deps.db
    .commit([{ op: 'set', path: cur.path, data: { codeHash: null, attempts: 0, ...(purpose === 'sensitive' ? { stepUpUntil: now + STEP_UP_MS } : {}) }, merge: true, precondition: pre }])
    .catch(conflict);
  if (purpose === 'verify_email') await deps.accounts.update(uid, { emailVerified: true });
  return { verified: true };
}

/** True when the person confirmed an email code for a sensitive action in the last 10 minutes. */
export async function hasRecentStepUp(db: Firestore, uid: string, now = Date.now()): Promise<boolean> {
  const d = (await db.get<CodeDoc>(path(uid, 'sensitive')))?.data;
  return (d?.stepUpUntil ?? 0) > now;
}
