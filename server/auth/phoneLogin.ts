/**
 * Sign-in with a verified phone number and the account password.
 *
 * The browser signs in to Firebase with an email address, so the server
 * resolves the number to its account and checks the password first; only
 * when both match does it return that account's email, and the browser then
 * signs in normally (same provider, sessions and security as an email
 * sign-in). Every failure (unknown number, unverified number, account without
 * a password, wrong password) gets the same answer and a similar response
 * time, so the form cannot be used to find out which numbers have accounts.
 * Attempts are limited per number and per client; wrong passwords count
 * towards the existing failed sign-in alert.
 */
import { createHmac } from 'node:crypto';
import type { AccountAdmin } from '../admin.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { phoneKey } from './otp.js';
import { normalizePhone } from './phone.js';

const HOUR = 3_600_000;
export const PHONE_LOGIN_PER_PHONE_HOUR = 10;
export const PHONE_LOGIN_PER_IP_HOUR = 30;
/** pad every answer to about this long, so a quick "no such number" looks like a password check */
const MIN_RESPONSE_MS = 700;

export interface PhoneLoginDeps {
  db: Firestore;
  accounts: AccountAdmin;
  secret: string;
  checkPassword: (email: string, password: string) => Promise<'ok' | 'wrong' | 'disabled'>;
  /** count a wrong password towards the failed sign-in alert (by email) */
  onWrongPassword?: (email: string) => Promise<void>;
  now?: () => number;
  minResponseMs?: number;
}

const hmac = (secret: string, v: string) => createHmac('sha256', secret).update(v).digest('hex');
const INVALID = 'Incorrect phone number or password.';

/** Record one attempt; refuse once the hourly allowance is used up. */
async function attempt(db: Firestore, path: string, now: number, perHour: number) {
  const doc = await db.get<{ sends?: number[] }>(path);
  const recent = (doc?.data.sends ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= perHour) {
    const wait = Math.min(...recent) + HOUR - now;
    throw new HttpError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again later or reset your password.', {
      retryAfter: Math.max(1, Math.ceil(wait / 1000)),
    });
  }
  await db.set(path, { sends: [...recent, now] });
}

/** The email of the account that verified this number, if it can sign in with a password. */
async function accountFor(deps: PhoneLoginDeps, e164: string): Promise<string | null> {
  const owner = await deps.db.get<{ uid: string }>(`phoneNumbers/${phoneKey(deps.secret, e164)}`);
  const uid = owner?.data.uid;
  if (!uid) return null;
  const [account, profile] = await Promise.all([
    deps.accounts.get(uid),
    deps.db.get<{ phoneNumber?: string | null; phoneVerified?: boolean }>(`users/${uid}`),
  ]);
  if (
    !account?.email ||
    !account.providers.includes('password') ||
    account.claims.phoneVerified !== true ||
    profile?.data.phoneVerified !== true ||
    profile.data.phoneNumber !== e164
  )
    return null;
  return account.email;
}

export async function phoneLogin(deps: PhoneLoginDeps, rawPhone: string, password: string, ip: string): Promise<{ email: string }> {
  const started = Date.now();
  const now = (deps.now ?? Date.now)();
  const pad = async () => {
    const left = (deps.minResponseMs ?? MIN_RESPONSE_MS) - (Date.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  };
  const phone = normalizePhone(rawPhone);
  if (!phone.ok) throw new HttpError(400, 'invalid_phone', 'Enter a valid Ghana mobile number, for example 024 123 4567.');
  if (!password || password.length > 200) throw new HttpError(400, 'bad_request', 'Enter your password.');

  await attempt(deps.db, `rateLimits/lp_${hmac(deps.secret, `ip|${ip}`).slice(0, 40)}`, now, PHONE_LOGIN_PER_IP_HOUR);
  await attempt(deps.db, `rateLimits/lf_${hmac(deps.secret, `phone|${phone.e164}`).slice(0, 40)}`, now, PHONE_LOGIN_PER_PHONE_HOUR);

  const email = await accountFor(deps, phone.e164);
  if (!email) {
    await pad();
    throw new HttpError(401, 'invalid_login', INVALID);
  }
  const result = await deps.checkPassword(email, password);
  if (result === 'wrong') {
    await deps.onWrongPassword?.(email).catch(() => undefined);
    await pad();
    throw new HttpError(401, 'invalid_login', INVALID);
  }
  // A suspended account: the browser's own sign-in shows the usual message, as for email sign-in.
  return { email };
}
