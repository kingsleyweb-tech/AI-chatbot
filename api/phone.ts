import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import {
  decideAccess,
  requireVerifiedEmail,
  type AccessConfig,
  type GateProfile,
} from '../server/access.js';
import { securityChangeAlert } from '../server/account/alerts.js';
import { submitRequest } from '../server/account/requests.js';
import { clientInfo } from '../server/account/devices.js';
import { emailDeps } from '../server/email/index.js';
import { deviceLabel, recordSecurityEvent } from '../server/account/events.js';
import { accountAdmin, adminConfigured, adminDb, mergeCustomClaims } from '../server/admin.js';
import { needsPhone, requireUser, type AuthUser } from '../server/auth.js';
import { otpStatus, phoneKey, sendCode, verifyCode, type OtpDeps } from '../server/auth/otp.js';
import { maskPhone } from '../server/auth/phone.js';
import { env } from '../server/env.js';
import { SERVER_TIME, type Write } from '../server/firestore.js';
import { handle, HttpError, json, readJson, readText } from '../server/http.js';
import { getOtpGateway, getSmsProvider } from '../server/sms/provider.js';
import { handleVynfyWebhook } from '../server/sms/webhook.js';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('send'), phone: z.string().min(9).max(24) }),
  z.object({ action: z.literal('resend') }),
  z.object({ action: z.literal('verify'), code: z.string().max(10) }),
  z.object({ action: z.literal('remove') }),
]);

async function deps(): Promise<OtpDeps> {
  const e = env();
  const sms = getSmsProvider();
  const otp = getOtpGateway();
  if (!adminConfigured() || !(sms || otp) || e.otpSecret.length < 32) {
    throw new HttpError(
      503,
      'otp_unavailable',
      'Phone verification is not configured on the server yet.',
    );
  }
  return {
    db: await adminDb(),
    sms,
    otp,
    secret: e.otpSecret,
    dailyCap: e.otpDailyCap,
    otpLength: e.otpLength,
    otpExpiryMin: e.otpExpiryMin,
    smsFallback: e.otpSmsFallback,
  };
}

/**
 * Texts cost money. New email/password sign-ups verify their phone before an
 * administrator reviews them, so pending accounts may request codes (limited
 * per account, per number and per day in otp.ts); rejected, suspended and
 * deleted accounts may not.
 */
async function assertMayVerify(user: AuthUser, db: OtpDeps['db']) {
  const [config, profile] = await Promise.all([
    db.get<AccessConfig>('config/access').then((d) => d?.data ?? null),
    db.get<GateProfile>(`users/${user.uid}`).then((d) => d?.data),
  ]);
  if (profile?.accountStatus && profile.accountStatus !== 'active') {
    throw new HttpError(403, 'account_suspended', 'This account is not active.');
  }
  const gate = decideAccess(
    { ...user, emailVerified: true, phoneVerified: true },
    profile,
    config,
    env().adminEmails,
    null,
    { ignoreConsent: true },
  );
  if (gate.state === 'rejected')
    throw new HttpError(
      403,
      'access_rejected',
      'Access to Atlas AI was not approved for this account.',
    );
}

/**
 * Phone numbers for every account. Email/password accounts must verify one
 * before using the app; Google accounts may add one later for account
 * security and SMS password recovery. Codes are generated, stored (hashed)
 * and checked only here; the browser never sees a code or the SMS
 * credentials. Success sets the phoneVerified custom claim, which the
 * Firestore rules and every API require for password sign-ins.
 *
 * Changing a number: the new number must be verified before it replaces the
 * old one (the old number stays on the account until the new code is
 * accepted, then its ownership record is released).
 */
export const POST = handle(async (request) => {
  // Vynfy delivery reports (configured in the Vynfy dashboard as .../api/phone?webhook=vynfy)
  if (new URL(request.url).searchParams.get('webhook') === 'vynfy') {
    if (!adminConfigured()) throw new HttpError(503, 'unavailable', 'Not configured.');
    const r = await handleVynfyWebhook(
      await adminDb(),
      env().vynfyWebhookSecret,
      await readText(request, 20_000),
      request.headers.get('x-webhook-signature'),
    );
    return json(r.body, { status: r.status });
  }
  const user = await requireUser(request);
  const parsed = schema.safeParse(await readJson(request, 10_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  const required = user.provider === 'password';
  const configured =
    adminConfigured() &&
    Boolean(getSmsProvider() || getOtpGateway()) &&
    env().otpSecret.length >= 32;

  if (b.action === 'status') {
    if (!configured)
      return json({
        required,
        verified: !needsPhone(user),
        phoneVerified: user.phoneVerified,
        configured,
      });
    const d = await deps();
    return json({
      required,
      verified: !needsPhone(user),
      phoneVerified: user.phoneVerified,
      configured,
      ...(await otpStatus(d, user.uid)),
    });
  }

  const d = await deps();
  const device = deviceLabel(request.headers.get('user-agent'));

  if (b.action === 'send' || b.action === 'resend') {
    // Adding the first number is part of sign-up; changing a verified one needs a verified email.
    if (user.phoneVerified) requireVerifiedEmail(user);
    await assertMayVerify(user, d.db);
    return json({
      ok: true,
      ...(await sendCode(d, user.uid, b.action === 'send' ? b.phone : null)),
    });
  }

  if (b.action === 'remove') {
    requireVerifiedEmail(user);
    await assertMayVerify(user, d.db);
    // Password accounts need a verified number to sign in: they can change it, not remove it.
    const account = await accountAdmin().get(user.uid);
    if (!account || account.providers.includes('password')) {
      throw new HttpError(
        400,
        'phone_required',
        'Accounts with a password need a verified phone number. You can change it instead.',
      );
    }
    const profile = (await d.db.get<{ phoneNumber?: string | null }>(`users/${user.uid}`))?.data;
    const writes: Write[] = [
      {
        op: 'set',
        path: `users/${user.uid}`,
        data: {
          phoneNumber: null,
          phoneVerified: false,
          phoneVerifiedAt: null,
          phoneReminderNextAt: null,
        },
        merge: true,
      },
      {
        op: 'set',
        path: `otp/${user.uid}`,
        data: { verifiedPhoneHash: null, codeHash: null },
        merge: true,
      },
    ];
    if (profile?.phoneNumber) {
      const owner = await d.db.get<{ uid: string }>(
        `phoneNumbers/${phoneKey(d.secret, profile.phoneNumber)}`,
      );
      if (owner?.data.uid === user.uid) writes.push({ op: 'delete', path: owner.path });
    }
    await d.db.commit(writes);
    await mergeCustomClaims(user.uid, { phoneVerified: null });
    await recordSecurityEvent(d.db, user.uid, 'phone_removed', { provider: user.provider, device });
    waitUntil(
      securityChangeAlert(
        emailDeps(d.db),
        user,
        'The phone number was removed from your account',
        clientInfo(request.headers),
      ),
    );
    return json({ ok: true });
  }

  const previous =
    (await d.db.get<{ phoneNumber?: string | null }>(`users/${user.uid}`))?.data.phoneNumber ??
    null;
  const { phone } = await verifyCode(d, user.uid, b.code.trim());
  await mergeCustomClaims(user.uid, { phoneVerified: true });
  await d.db.set(
    `users/${user.uid}`,
    { phoneNumber: phone, phoneVerified: true, phoneVerifiedAt: SERVER_TIME },
    true,
  );
  // keep a pending access request in step with the verified number
  const req = await d.db.get<{ phoneNumber?: string | null; status?: string }>(
    `accessRequests/${user.uid}`,
  );
  if (req && (req.data.phoneNumber === phone || user.provider === 'password')) {
    await d.db.set(
      req.path,
      { phoneNumber: phone, phoneNorm: phone, phoneVerified: true, updatedAt: Date.now() },
      true,
    );
  } else if (!req && user.provider === 'password') {
    // A new sign-up: file the access request now (name from sign-up, verified number), so the
    // person waits for approval without filling in another form. With automatic approval on,
    // or for an already approved account, nothing is filed and they go straight in.
    const name = (await d.db.get<{ displayName?: string }>(`users/${user.uid}`))?.data.displayName;
    await submitRequest(d.db, { ...user, phoneVerified: true }, {
      fullName: name || user.name || user.email?.split('@')[0] || 'Atlas AI user',
    }).catch((err) =>
      console.warn('[phone] access request not filed', err instanceof Error ? err.message : err),
    );
  }
  await recordSecurityEvent(
    d.db,
    user.uid,
    previous && previous !== phone ? 'phone_changed' : 'phone_verified',
    { provider: user.provider, device },
  );
  // A first verification is part of signing up; a change of number is worth an email.
  if (previous && previous !== phone) {
    waitUntil(
      securityChangeAlert(
        emailDeps(d.db),
        user,
        `The phone number on your account was changed to one ending in ${phone.slice(-3)}`,
        clientInfo(request.headers),
      ),
    );
  }
  return json({ ok: true, verified: true, phoneMasked: maskPhone(phone) });
});
