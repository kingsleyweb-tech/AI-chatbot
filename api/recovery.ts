import { z } from 'zod';
import { deviceLabel } from '../server/account/events.js';
import { accountAdmin, adminConfigured, adminDb } from '../server/admin.js';
import { recordFailedLogin, resetPassword, startRecovery, verifyRecovery, type RecoveryDeps } from '../server/auth/recovery.js';
import { env } from '../server/env.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { getSmsProvider } from '../server/sms/provider.js';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), email: z.string().min(3).max(320) }),
  z.object({ action: z.literal('verify'), recoveryId: z.string().max(64), code: z.string().max(10) }),
  z.object({ action: z.literal('reset'), recoveryId: z.string().max(64), resetToken: z.string().max(100), password: z.string().max(200) }),
  z.object({ action: z.literal('failedLogin'), email: z.string().min(3).max(320) }),
]);

let depsOverride: Partial<RecoveryDeps> | null = null;
/** test hook (e.g. no decoy delay) */
export function setRecoveryDeps(d: Partial<RecoveryDeps> | null) {
  depsOverride = d;
}

async function deps(): Promise<RecoveryDeps> {
  const e = env();
  const sms = getSmsProvider();
  if (!adminConfigured() || !sms || e.otpSecret.length < 32) {
    throw new HttpError(503, 'recovery_unavailable', 'Password reset by text message is not available right now. Use the email link instead.');
  }
  return { db: await adminDb(), sms, accounts: accountAdmin(), secret: e.otpSecret, dailyCap: e.otpDailyCap, ...depsOverride };
}

function clientIp(request: Request) {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Public (signed-out) account recovery: password reset by SMS code for
 * email/password accounts with a verified phone number. Responses never
 * reveal whether an email address has an account.
 */
export const POST = handle(async (request) => {
  const parsed = schema.safeParse(await readJson(request, 5_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  const device = deviceLabel(request.headers.get('user-agent'));

  if (b.action === 'failedLogin') {
    if (adminConfigured() && env().otpSecret.length >= 32) {
      await recordFailedLogin({ db: await adminDb(), accounts: accountAdmin(), secret: env().otpSecret, ...depsOverride }, b.email, device).catch((err) =>
        console.warn('[recovery] failed-login record skipped', err instanceof Error ? err.message : err),
      );
    }
    return json({ ok: true });
  }
  const d = await deps();
  if (b.action === 'start') return json({ ok: true, ...(await startRecovery(d, b.email, clientIp(request))) });
  if (b.action === 'verify') return json({ ok: true, ...(await verifyRecovery(d, b.recoveryId, b.code.trim())) });
  await resetPassword(d, b.recoveryId, b.resetToken, b.password, device);
  return json({ ok: true });
});
