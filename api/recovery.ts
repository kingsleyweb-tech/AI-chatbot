import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { clientInfo } from '../server/account/devices.js';
import { deviceLabel } from '../server/account/events.js';
import { emailDeps } from '../server/email/index.js';
import { accountAdmin, adminConfigured, adminDb, checkPassword } from '../server/admin.js';
import { phoneLogin, type PhoneLoginDeps } from '../server/auth/phoneLogin.js';
import { recordFailedLogin, resetPassword, startRecovery, verifyRecovery, type RecoveryDeps } from '../server/auth/recovery.js';
import { env } from '../server/env.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { getSmsProvider } from '../server/sms/provider.js';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), email: z.string().min(3).max(320), channel: z.enum(['sms', 'email']).optional() }),
  z.object({ action: z.literal('verify'), recoveryId: z.string().max(64), code: z.string().max(10) }),
  z.object({ action: z.literal('reset'), recoveryId: z.string().max(64), resetToken: z.string().max(100), password: z.string().max(200) }),
  z.object({ action: z.literal('failedLogin'), email: z.string().min(3).max(320) }),
  z.object({ action: z.literal('phoneLogin'), phone: z.string().min(6).max(24), password: z.string().min(1).max(200) }),
]);

let depsOverride: Partial<RecoveryDeps> | null = null;
/** test hook (e.g. no decoy delay) */
export function setRecoveryDeps(d: Partial<RecoveryDeps> | null) {
  depsOverride = d;
}
let phoneLoginOverride: Partial<PhoneLoginDeps> | null = null;
/** test hook (fake password check, no response padding) */
export function setPhoneLoginDeps(d: Partial<PhoneLoginDeps> | null) {
  phoneLoginOverride = d;
}

async function deps(request: Request): Promise<RecoveryDeps> {
  const e = env();
  if (!adminConfigured() || e.otpSecret.length < 32) {
    throw new HttpError(503, 'recovery_unavailable', 'Password reset with a code is not available right now. Use the email link instead.');
  }
  const db = await adminDb();
  return {
    db,
    sms: getSmsProvider(),
    mail: emailDeps(db),
    client: clientInfo(request.headers),
    background: (p) => waitUntil(p),
    accounts: accountAdmin(),
    secret: e.otpSecret,
    dailyCap: e.otpDailyCap,
    ...depsOverride,
  };
}

function clientIp(request: Request) {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Public (signed-out) account recovery: password reset by a code sent by SMS
 * (accounts with a verified phone number) or by email, and sign-in with a
 * verified phone number and password. Responses never reveal whether an
 * email address or phone number has an account.
 */
export const POST = handle(async (request) => {
  const parsed = schema.safeParse(await readJson(request, 5_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  const device = deviceLabel(request.headers.get('user-agent'));

  if (b.action === 'failedLogin') {
    if (adminConfigured() && env().otpSecret.length >= 32) {
      const db = await adminDb();
      const extra = { mail: emailDeps(db), client: clientInfo(request.headers), background: (p: Promise<unknown>) => waitUntil(p) };
      await recordFailedLogin({ db, accounts: accountAdmin(), secret: env().otpSecret, ...extra, ...depsOverride }, b.email, device).catch((err) =>
        console.warn('[recovery] failed-login record skipped', err instanceof Error ? err.message : err),
      );
    }
    return json({ ok: true });
  }
  if (b.action === 'phoneLogin') {
    if (!adminConfigured() || env().otpSecret.length < 32)
      throw new HttpError(503, 'phone_login_unavailable', 'Sign-in with a phone number is not available right now. Use your email address.');
    const db = await adminDb();
    const accounts = accountAdmin();
    const secret = env().otpSecret;
    const extra = { mail: emailDeps(db), client: clientInfo(request.headers), background: (p: Promise<unknown>) => waitUntil(p) };
    const r = await phoneLogin(
      {
        db,
        accounts,
        secret,
        checkPassword,
        onWrongPassword: (email) => recordFailedLogin({ db, accounts, secret, ...extra, ...depsOverride }, email, device),
        ...phoneLoginOverride,
      },
      b.phone,
      b.password,
      clientIp(request),
    );
    return json({ ok: true, email: r.email });
  }
  const d = await deps(request);
  if (b.action === 'start') return json({ ok: true, ...(await startRecovery(d, b.email, clientIp(request), b.channel ?? 'sms')) });
  if (b.action === 'verify') return json({ ok: true, ...(await verifyRecovery(d, b.recoveryId, b.code.trim())) });
  await resetPassword(d, b.recoveryId, b.resetToken, b.password, device);
  return json({ ok: true });
});
