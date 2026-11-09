/**
 * Security emails triggered by account activity. Every function here is best
 * effort: it never throws, so the sign-in or change that triggered it is never
 * affected by email trouble.
 */
import { sendEmail, type EmailDeps, type SendOutcome } from '../email/service.js';
import type { EmailType } from '../email/templates.js';
import { checkSignIn, deviceFacts, type ClientInfo } from './devices.js';

export interface AlertUser {
  uid: string;
  email: string | null;
  name?: string | null;
  /** false: the address is not proved yet, so no alert is sent to it (it may be someone else's) */
  emailVerified?: boolean;
}

/** Alerts go only to an address the account has proved it owns. */
const mailable = (u: AlertUser) => Boolean(u.email) && u.emailVerified !== false;

const skip = (why: string): SendOutcome => ({ sent: false, status: 'invalid', error: why });

/**
 * Once per sign-in session (auth_time, never on token refresh): record the
 * device and send a sign-in alert, saying whether the device is recognised,
 * or an unusual-sign-in alert for a new device in a new country. The sign-in
 * that follows creating an account is not reported (the account is brand new).
 */
export async function signInAlert(
  mail: EmailDeps,
  secret: string,
  user: AlertUser,
  authTime: number,
  client: ClientInfo,
  opts: { newAccount?: boolean } = {},
): Promise<SendOutcome & { known?: boolean }> {
  try {
    const check = await checkSignIn(mail.db, secret, user.uid, client, authTime * 1000);
    if (!mailable(user) || !user.email) return { ...skip('no_email'), known: check.known };
    if (check.first && opts.newAccount) return { ...skip('new_account'), known: false };
    const type: EmailType = check.suspicious ? 'suspicious_login' : 'new_login';
    const r = await sendEmail(mail, {
      type,
      category: check.suspicious ? 'suspicious' : 'newLogin',
      to: user.email,
      uid: user.uid,
      data: {
        name: user.name,
        device: check.facts,
        at: authTime * 1000,
        timeZone: client.timeZone,
        reason: check.suspicious ?? undefined,
        knownDevice: check.known,
      },
      dedupeKey: `login|${user.uid}|${authTime}`,
      dedupeMs: 7 * 86_400_000,
    });
    return { ...r, known: check.known };
  } catch (err) {
    console.warn('[alerts] sign-in check skipped', err instanceof Error ? err.message : err);
    return skip('error');
  }
}

/** "A phone number was added", "You signed out of every device"… (optional security notification). */
export async function securityChangeAlert(
  mail: EmailDeps,
  user: AlertUser,
  change: string,
  client: ClientInfo,
  dedupeKey?: string,
): Promise<SendOutcome> {
  if (!mailable(user) || !user.email) return skip('no_email');
  return sendEmail(mail, {
    type: 'security_change',
    category: 'security',
    to: user.email,
    uid: user.uid,
    data: { name: user.name, change, device: deviceFacts(client), timeZone: client.timeZone },
    dedupeKey,
    dedupeMs: 10 * 60_000,
  });
}

/** Password changed or reset: always sent (cannot be turned off). */
export async function passwordChangedAlert(
  mail: EmailDeps,
  user: AlertUser,
  how: string,
  client: ClientInfo,
): Promise<SendOutcome> {
  if (!mailable(user) || !user.email) return skip('no_email');
  return sendEmail(mail, {
    type: 'password_changed',
    category: 'critical',
    to: user.email,
    uid: user.uid,
    data: { name: user.name, reason: how, device: deviceFacts(client), timeZone: client.timeZone },
    dedupeKey: `pw|${user.uid}|${Math.floor(mail.now ? mail.now() / 60_000 : Date.now() / 60_000)}`,
    dedupeMs: 5 * 60_000,
  });
}
