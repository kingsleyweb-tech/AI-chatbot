import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import {
  accessConfig,
  accountBlock,
  approvalConfig,
  decideAccess,
  requestDeviceKey,
  requireVerifiedEmail,
} from '../server/access.js';
import {
  passwordChangedAlert,
  securityChangeAlert,
  signInAlert,
} from '../server/account/alerts.js';
import { acceptTerms } from '../server/account/consent.js';
import { clientInfo, listDevices } from '../server/account/devices.js';
import { sendEmailCode, verifyEmailCode } from '../server/auth/emailCode.js';
import { emailDeps, sendEmail } from '../server/email/index.js';
import { EMAIL_PREF_KEYS, prefsFrom } from '../server/email/service.js';
import { deviceLabel, recordSecurityEvent } from '../server/account/events.js';
import {
  ensureProfile,
  ownRequestView,
  submitRequest,
  type AccessRequest,
  type ProfileForAccess,
} from '../server/account/requests.js';
import { accountAdmin, adminConfigured, adminDb, mergeCustomClaims } from '../server/admin.js';
import { isSuperAdmin } from '../server/chat/ownership.js';
import { maskPhone } from '../server/auth/phone.js';
import { env } from '../server/env.js';
import { requireUser } from '../server/auth.js';
import { SERVER_TIME } from '../server/firestore.js';
import { handle, HttpError, json, readJson } from '../server/http.js';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('access'), name: z.string().max(100).optional() }),
  z.object({
    action: z.literal('acceptTerms'),
    termsVersion: z.string().max(20),
    privacyVersion: z.string().max(20),
    name: z.string().max(100).optional(),
  }),
  z.object({
    action: z.literal('requestAccess'),
    fullName: z.string().min(1).max(100),
    phone: z.string().max(24).optional(),
    dialCode: z.string().max(5).optional(),
    reason: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal('session') }),
  z.object({
    action: z.literal('clientReport'),
    kind: z.enum(['error', 'api', 'slow']),
    message: z.string().max(300),
    path: z.string().max(100).optional(),
    status: z.number().int().min(0).max(999).optional(),
    ms: z.number().int().min(0).max(600_000).optional(),
  }),
  z.object({ action: z.literal('passwordChanged') }),
  z.object({ action: z.literal('providerLinked'), provider: z.enum(['password', 'google.com']) }),
  z.object({ action: z.literal('revokeSessions') }),
  z.object({ action: z.literal('exported') }),
  z.object({ action: z.literal('signedOut'), reason: z.enum(['user', 'inactivity']) }),
  z.object({ action: z.literal('emailCodeSend'), purpose: z.enum(['verify_email', 'sensitive']) }),
  z.object({
    action: z.literal('emailCodeVerify'),
    purpose: z.enum(['verify_email', 'sensitive']),
    code: z.string().max(10),
  }),
  z.object({ action: z.literal('emailPrefs') }),
  z.object({
    action: z.literal('setEmailPrefs'),
    prefs: z
      .object(Object.fromEntries(EMAIL_PREF_KEYS.map((k) => [k, z.boolean().optional()])))
      .strict(),
  }),
  z.object({ action: z.literal('devices') }),
  z.object({ action: z.literal('forgetDevice'), id: z.string().regex(/^[a-f0-9]{32}$/) }),
]);

/** Welcome email for accounts created in the last week, once (after approval and a verified address). */
const WELCOME_WINDOW_MS = 7 * 86_400_000;
function createdAtMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  return 0;
}

interface Profile {
  accountStatus?: string;
  sessionsValidAfter?: number;
  purgeAfter?: number;
  lastAuthTime?: number;
}

interface StoredProfile {
  consent?: Partial<import('../server/shared/legal.js').ConsentRecord> | null;
  settings?: unknown;
  lastAuthTime?: number;
  sessionsValidAfter?: number;
}

/** Recent enough to be the change the client just made (it reports right after). */
const RECENT_MS = 10 * 60_000;

/**
 * Signed-in account operations that need privileged access: account status
 * (also for suspended accounts, which the rules lock out of their own
 * profile), trusted security events, and signing out every session.
 * Events are only recorded after the server has confirmed the change itself.
 */
export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const parsed = schema.safeParse(await readJson(request, 4_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  if (b.action === 'clientReport') {
    // Client monitoring: one line in the server log. The client already removed personal data;
    // this trims again and never stores anything.
    const clean = (t: string) =>
      t
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
        .replace(/\s+/g, ' ')
        .slice(0, 300);
    console.warn(
      '[client]',
      JSON.stringify({
        kind: b.kind,
        message: clean(b.message),
        path: b.path ? clean(b.path) : undefined,
        status: b.status,
        ms: b.ms,
        uid: user.uid.slice(0, 6),
      }),
    );
    return json({ ok: true });
  }
  if (!adminConfigured()) {
    if (
      b.action === 'status' ||
      b.action === 'session' ||
      b.action === 'exported' ||
      b.action === 'access' ||
      b.action === 'signedOut' ||
      b.action === 'acceptTerms'
    )
      return json({ ok: true, configured: false, accountStatus: 'active' });
    throw new HttpError(
      503,
      'admin_unconfigured',
      'This needs the server service account, which is not configured yet.',
    );
  }
  const db = await adminDb();
  const device = deviceLabel(request.headers.get('user-agent'));
  const profilePath = `users/${user.uid}`;
  const client = clientInfo(request.headers);
  const mail = emailDeps(db);
  const secret = env().otpSecret;
  /** new sign-in session: device check and alert, after the response */
  const afterSignIn = (createdAt: unknown) => {
    const created = createdAtMs(createdAt);
    // the sign-in right after registering is not reported
    const newAccount = !!created && user.authTime * 1000 - created < 15 * 60_000;
    if (secret.length >= 32)
      waitUntil(signInAlert(mail, secret, user, user.authTime, client, { newAccount }));
  };

  if (b.action === 'status') {
    const p = (await db.get<Profile>(profilePath))?.data;
    const block = accountBlock(p, user.authTime, requestDeviceKey(user.uid, request));
    return json({
      ok: true,
      configured: true,
      accountStatus: p?.accountStatus ?? 'active',
      sessionRevoked: block?.code === 'session_revoked',
      deviceRemoved: block?.code === 'device_removed',
      purgeAfter: p?.accountStatus === 'deleted' ? (p.purgeAfter ?? null) : null,
    });
  }

  if (b.action === 'access' || b.action === 'acceptTerms') {
    // Where this account stands, decided on the server. Every signed-in person gets a profile
    // here, including those not approved yet. All reads happen in parallel; the profile is
    // created (and approved automatically when an administrator turned that on) in one write.
    const [config, approval, stored, requestDoc] = await Promise.all([
      accessConfig(db, true),
      approvalConfig(db, true),
      db.get<ProfileForAccess & StoredProfile>(profilePath),
      db.get<AccessRequest>(`accessRequests/${user.uid}`),
    ]);
    const now = Date.now();
    let profile: ProfileForAccess & StoredProfile = await ensureProfile(db, user, config, b.name, {
      existing: stored?.data ?? null,
      autoApprove: approval?.autoApprove === true,
      now,
    });
    if (b.action === 'acceptTerms') {
      const r = await acceptTerms(db, user, b, profile.consent, device, now);
      profile = { ...profile, consent: r.consent };
    }
    const block = accountBlock(profile, user.authTime);
    const request = requestDoc?.data ?? null;
    const gate = decideAccess(user, profile, config, env().adminEmails, request);
    let needsSettings = false;
    if (gate.state === 'approved' && !block) {
      // Sign-in bookkeeping the browser used to do in separate round trips: login fields and
      // one login event per sign-in session (auth_time from the verified token).
      const patch: Record<string, unknown> = {
        provider: user.provider || profile.provider || 'unknown',
        emailVerified: user.emailVerified,
      };
      if (!profile.photoURL && user.picture) patch.photoURL = user.picture;
      const newSession = (profile.lastAuthTime ?? 0) < user.authTime;
      if (newSession)
        Object.assign(patch, { lastAuthTime: user.authTime, lastLoginAt: SERVER_TIME });
      await db.set(profilePath, patch, true);
      if (newSession) {
        await recordSecurityEvent(
          db,
          user.uid,
          'login',
          { provider: user.provider, device },
          user.authTime * 1000,
        );
        afterSignIn((profile as { createdAt?: unknown }).createdAt);
      }
      needsSettings = !profile.settings;
      const created = createdAtMs((profile as { createdAt?: unknown }).createdAt);
      if (user.emailVerified && user.email && created && now - created < WELCOME_WINDOW_MS) {
        waitUntil(
          sendEmail(mail, {
            type: 'welcome',
            category: 'critical',
            to: user.email,
            uid: user.uid,
            data: { name: profile.displayName ?? user.name },
            dedupeKey: `welcome|${user.uid}`,
            dedupeMs: 365 * 86_400_000,
          }),
        );
      }
    }
    // The Super Admin is recognised by a custom claim the server sets from ADMIN_EMAILS, so
    // the Firestore rules and the browser never need the owner's email address. Removed again
    // when the address leaves ADMIN_EMAILS. The browser refreshes its token when told to.
    const superAdmin = isSuperAdmin(user, env().adminEmails);
    let refreshToken = false;
    if (superAdmin !== Boolean(user.superAdminClaim)) {
      try {
        await mergeCustomClaims(user.uid, { superAdmin: superAdmin ? true : null });
        refreshToken = true;
      } catch (err) {
        console.error('[access] super admin claim update failed', err instanceof Error ? err.message : 'unknown');
      }
    }
    return json({
      ok: true,
      configured: true,
      state: block?.code === 'session_revoked' ? 'revoked' : gate.state,
      admin: gate.admin,
      superAdmin,
      refreshToken,
      accessStatus: profile.accessStatus ?? 'pending',
      autoApproved: Boolean((profile as { autoApproved?: boolean }).autoApproved),
      needsSettings,
      profile: {
        displayName: profile.displayName ?? null,
        email: user.email,
        phoneMasked: profile.phoneNumber ? maskPhone(profile.phoneNumber) : null,
        phoneVerified: Boolean(profile.phoneVerified),
      },
      request: ownRequestView(request),
    });
  }

  if (b.action === 'requestAccess') {
    const r = await submitRequest(db, user, {
      fullName: b.fullName,
      phone: b.phone,
      dialCode: b.dialCode,
      reason: b.reason,
    });
    return json({
      ok: true,
      state: r.state,
      created: r.created,
      request: ownRequestView(r.request),
    });
  }

  if (b.action === 'session') {
    // One login event per sign-in session (auth_time comes from the verified token).
    const p = (await db.get<Profile>(profilePath))?.data;
    if (accountBlock(p, user.authTime)) return json({ ok: true, recorded: false });
    if ((p?.lastAuthTime ?? 0) >= user.authTime) return json({ ok: true, recorded: false });
    await db.set(profilePath, { lastAuthTime: user.authTime, lastLoginAt: SERVER_TIME }, true);
    await recordSecurityEvent(
      db,
      user.uid,
      'login',
      { provider: user.provider, device },
      user.authTime * 1000,
    );
    afterSignIn((p as { createdAt?: unknown } | undefined)?.createdAt);
    return json({ ok: true, recorded: true });
  }

  if (b.action === 'emailCodeSend' || b.action === 'emailCodeVerify') {
    if (secret.length < 32)
      throw new HttpError(503, 'email_unavailable', 'Email codes are not available right now.');
    const deps = { db, accounts: accountAdmin(), mail, secret };
    if (b.purpose === 'sensitive') requireVerifiedEmail(user);
    if (b.action === 'emailCodeSend')
      return json({ ok: true, ...(await sendEmailCode(deps, user, b.purpose, client.timeZone)) });
    const r = await verifyEmailCode(deps, user.uid, b.purpose, b.code.trim());
    if (b.purpose === 'verify_email')
      await recordSecurityEvent(db, user.uid, 'email_verified', {
        provider: user.provider,
        device,
        detail: 'Verified with an email code',
      });
    return json({ ok: true, ...r });
  }

  if (b.action === 'emailPrefs') {
    const p = (await db.get<{ emailPrefs?: unknown }>(profilePath))?.data;
    return json({ ok: true, prefs: prefsFrom(p?.emailPrefs), configured: Boolean(mail.provider) });
  }

  if (b.action === 'setEmailPrefs') {
    const cur = prefsFrom((await db.get<{ emailPrefs?: unknown }>(profilePath))?.data.emailPrefs);
    const prefs = {
      ...cur,
      ...Object.fromEntries(Object.entries(b.prefs).filter(([, v]) => typeof v === 'boolean')),
    };
    await db.set(profilePath, { emailPrefs: prefs }, true);
    return json({ ok: true, prefs });
  }

  if (b.action === 'devices') {
    if (secret.length < 32) return json({ ok: true, devices: [] });
    return json({ ok: true, devices: await listDevices(db, secret, user.uid, client) });
  }

  if (b.action === 'forgetDevice') {
    const path = `${profilePath}/devices/${b.id}`;
    const found = await db.get<{ browser?: string; os?: string }>(path);
    if (!found) throw new HttpError(404, 'not_found', 'That device is not in your list.');
    await db.delete(path);
    // End the sessions on that device: it notices the change to the profile and signs out,
    // and every server request from a session that started before now is refused.
    const nowSec = Math.floor(Date.now() / 1000);
    const prev =
      (
        (await db.get<Profile>(profilePath))?.data as
          { removedDevices?: Record<string, number> } | undefined
      )?.removedDevices ?? {};
    const removedDevices = Object.fromEntries(
      Object.entries({ ...prev, [b.id]: nowSec }).filter(
        ([, t]) => typeof t === 'number' && nowSec - t < 90 * 86_400,
      ),
    );
    await db.set(profilePath, { removedDevices }, true);
    await recordSecurityEvent(db, user.uid, 'device_removed', {
      provider: user.provider,
      device,
      detail: `${found.data.browser ?? 'Browser'} on ${found.data.os ?? 'unknown system'}`,
    });
    waitUntil(
      securityChangeAlert(
        mail,
        user,
        `A device (${found.data.browser ?? 'browser'} on ${found.data.os ?? 'unknown system'}) was removed from your recognised devices`,
        client,
      ),
    );
    return json({ ok: true });
  }

  if (b.action === 'signedOut') {
    // Security log only; the sign-out itself happens on the device. Nothing here can keep a session alive.
    await recordSecurityEvent(
      db,
      user.uid,
      b.reason === 'inactivity' ? 'logout_inactivity' : 'logout',
      { provider: user.provider, device, by: b.reason === 'inactivity' ? 'system' : 'user' },
    );
    return json({ ok: true });
  }

  if (b.action === 'exported') {
    await recordSecurityEvent(db, user.uid, 'data_exported', { provider: user.provider, device });
    return json({ ok: true });
  }

  const account = await accountAdmin().get(user.uid);
  if (!account) throw new HttpError(404, 'not_found', 'Account not found.');

  if (b.action === 'passwordChanged') {
    if (!account.passwordUpdatedAt || Date.now() - account.passwordUpdatedAt > RECENT_MS) {
      throw new HttpError(400, 'not_changed', 'No recent password change was found.');
    }
    await recordSecurityEvent(db, user.uid, 'password_changed', {
      provider: user.provider,
      device,
    });
    waitUntil(
      passwordChangedAlert(
        mail,
        { uid: user.uid, email: account.email ?? user.email, name: account.displayName },
        'changed in Settings',
        client,
      ),
    );
    return json({ ok: true });
  }

  if (b.action === 'providerLinked') {
    if (!account.providers.includes(b.provider))
      throw new HttpError(400, 'not_linked', 'That sign-in method is not linked to this account.');
    await recordSecurityEvent(db, user.uid, 'provider_linked', {
      provider: b.provider,
      device,
      detail: b.provider === 'password' ? 'Email and password added' : 'Google added',
    });
    waitUntil(
      securityChangeAlert(
        mail,
        user,
        b.provider === 'password'
          ? 'A password was added as a way to sign in'
          : 'Google sign-in was added to your account',
        client,
        `linked|${user.uid}|${b.provider}`,
      ),
    );
    return json({ ok: true, providers: account.providers });
  }

  // revokeSessions: every device, including this one, must sign in again.
  await accountAdmin().update(user.uid, { revokeSessions: true });
  await db.set(profilePath, { sessionsValidAfter: Math.floor(Date.now() / 1000) }, true);
  await recordSecurityEvent(db, user.uid, 'sessions_revoked', { provider: user.provider, device });
  waitUntil(securityChangeAlert(mail, user, 'Every device was signed out of your account', client));
  return json({ ok: true });
});
