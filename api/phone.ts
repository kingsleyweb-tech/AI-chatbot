import { z } from 'zod';
import { evaluateAccess, type AccessConfig } from '../server/access.js';
import { adminConfigured, adminDb, mergeCustomClaims } from '../server/admin.js';
import { needsPhone, requireUser, type AuthUser } from '../server/auth.js';
import { otpStatus, sendCode, verifyCode, type OtpDeps } from '../server/auth/otp.js';
import { env } from '../server/env.js';
import { SERVER_TIME } from '../server/firestore.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { getSmsProvider } from '../server/sms/provider.js';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('send'), phone: z.string().min(9).max(20) }),
  z.object({ action: z.literal('verify'), code: z.string().max(10) }),
]);

async function deps(): Promise<OtpDeps> {
  const e = env();
  const sms = getSmsProvider();
  if (!adminConfigured() || !sms || e.otpSecret.length < 32) {
    throw new HttpError(503, 'otp_unavailable', 'Phone verification is not configured on the server yet.');
  }
  return { db: await adminDb(), sms, secret: e.otpSecret, dailyCap: e.otpDailyCap };
}

/**
 * Texts cost money, so only accounts the owner has approved (allowlist or
 * admin) can request one. Email verification is not required yet: phone
 * verification comes first in the sign-up flow.
 */
async function assertApproved(user: AuthUser, db: OtpDeps['db']) {
  const config = (await db.get<AccessConfig>('config/access'))?.data ?? null;
  if (!evaluateAccess(user.email, true, config, env().adminEmails).ok) {
    throw new HttpError(403, 'not_allowed', 'This account is not approved.');
  }
}

/**
 * Phone verification for email/password accounts. Codes are generated,
 * stored (hashed) and checked only here; the browser never sees a code or
 * the SMS credentials. Success sets the phoneVerified custom claim that the
 * Firestore rules and every API require.
 */
export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const parsed = schema.safeParse(await readJson(request, 10_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  const required = user.provider === 'password';

  if (b.action === 'status') {
    if (!needsPhone(user)) return json({ required, verified: true, configured: true });
    const configured = adminConfigured() && Boolean(getSmsProvider()) && env().otpSecret.length >= 32;
    if (!configured) return json({ required, verified: false, configured });
    return json({ required, verified: false, configured, ...(await otpStatus(await deps(), user.uid)) });
  }

  if (!required) throw new HttpError(400, 'not_required', 'This sign-in method does not need phone verification.');
  if (user.phoneVerified) return json({ ok: true, verified: true });
  const d = await deps();

  if (b.action === 'send') {
    await assertApproved(user, d.db);
    return json({ ok: true, ...(await sendCode(d, user.uid, b.phone)) });
  }

  const { phone } = await verifyCode(d, user.uid, b.code.trim());
  await mergeCustomClaims(user.uid, { phoneVerified: true });
  await d.db.set(`users/${user.uid}`, { phoneNumber: phone, phoneVerified: true, phoneVerifiedAt: SERVER_TIME }, true);
  return json({ ok: true, verified: true });
});
