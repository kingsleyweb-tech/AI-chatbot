import { z } from 'zod';
import { accessConfig, accountBlock, decideAccess } from '../server/access.js';
import { deviceLabel, recordSecurityEvent } from '../server/account/events.js';
import { ensureProfile, ownRequestView, submitRequest, type AccessRequest } from '../server/account/requests.js';
import { accountAdmin, adminConfigured, adminDb } from '../server/admin.js';
import { maskPhone } from '../server/auth/phone.js';
import { env } from '../server/env.js';
import { requireUser } from '../server/auth.js';
import { SERVER_TIME } from '../server/firestore.js';
import { handle, HttpError, json, readJson } from '../server/http.js';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('access'), name: z.string().max(100).optional() }),
  z.object({
    action: z.literal('requestAccess'),
    fullName: z.string().min(1).max(100),
    phone: z.string().max(24).optional(),
    dialCode: z.string().max(5).optional(),
    reason: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal('session') }),
  z.object({ action: z.literal('passwordChanged') }),
  z.object({ action: z.literal('providerLinked'), provider: z.enum(['password', 'google.com']) }),
  z.object({ action: z.literal('revokeSessions') }),
  z.object({ action: z.literal('exported') }),
  z.object({ action: z.literal('signedOut'), reason: z.enum(['user', 'inactivity']) }),
]);

interface Profile {
  accountStatus?: string;
  sessionsValidAfter?: number;
  purgeAfter?: number;
  lastAuthTime?: number;
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
  if (!adminConfigured()) {
    if (b.action === 'status' || b.action === 'session' || b.action === 'exported' || b.action === 'access' || b.action === 'signedOut') return json({ ok: true, configured: false, accountStatus: 'active' });
    throw new HttpError(503, 'admin_unconfigured', 'This needs the server service account, which is not configured yet.');
  }
  const db = await adminDb();
  const device = deviceLabel(request.headers.get('user-agent'));
  const profilePath = `users/${user.uid}`;

  if (b.action === 'status') {
    const p = (await db.get<Profile>(profilePath))?.data;
    const block = accountBlock(p, user.authTime);
    return json({
      ok: true,
      configured: true,
      accountStatus: p?.accountStatus ?? 'active',
      sessionRevoked: block?.code === 'session_revoked',
      purgeAfter: p?.accountStatus === 'deleted' ? (p.purgeAfter ?? null) : null,
    });
  }

  if (b.action === 'access') {
    // Where this account stands, decided on the server. Every signed-in
    // person gets a profile here, including those not approved yet.
    const config = await accessConfig(db, true);
    const profile = await ensureProfile(db, user, config, b.name);
    const block = accountBlock(profile, user.authTime);
    const request = (await db.get<AccessRequest>(`accessRequests/${user.uid}`))?.data ?? null;
    const gate = decideAccess(user, profile, config, env().adminEmails, request);
    return json({
      ok: true,
      configured: true,
      state: block?.code === 'session_revoked' ? 'revoked' : gate.state,
      admin: gate.admin,
      accessStatus: profile.accessStatus ?? 'pending',
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
    const r = await submitRequest(db, user, { fullName: b.fullName, phone: b.phone, dialCode: b.dialCode, reason: b.reason });
    return json({ ok: true, state: r.state, created: r.created, request: ownRequestView(r.request) });
  }

  if (b.action === 'session') {
    // One login event per sign-in session (auth_time comes from the verified token).
    const p = (await db.get<Profile>(profilePath))?.data;
    if (accountBlock(p, user.authTime)) return json({ ok: true, recorded: false });
    if ((p?.lastAuthTime ?? 0) >= user.authTime) return json({ ok: true, recorded: false });
    await db.set(profilePath, { lastAuthTime: user.authTime, lastLoginAt: SERVER_TIME }, true);
    await recordSecurityEvent(db, user.uid, 'login', { provider: user.provider, device }, user.authTime * 1000);
    return json({ ok: true, recorded: true });
  }

  if (b.action === 'signedOut') {
    // Security log only; the sign-out itself happens on the device. Nothing here can keep a session alive.
    await recordSecurityEvent(db, user.uid, b.reason === 'inactivity' ? 'logout_inactivity' : 'logout', { provider: user.provider, device, by: b.reason === 'inactivity' ? 'system' : 'user' });
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
    await recordSecurityEvent(db, user.uid, 'password_changed', { provider: user.provider, device });
    return json({ ok: true });
  }

  if (b.action === 'providerLinked') {
    if (!account.providers.includes(b.provider)) throw new HttpError(400, 'not_linked', 'That sign-in method is not linked to this account.');
    await recordSecurityEvent(db, user.uid, 'provider_linked', { provider: b.provider, device, detail: b.provider === 'password' ? 'Email and password added' : 'Google added' });
    return json({ ok: true, providers: account.providers });
  }

  // revokeSessions: every device, including this one, must sign in again.
  await accountAdmin().update(user.uid, { revokeSessions: true });
  await db.set(profilePath, { sessionsValidAfter: Math.floor(Date.now() / 1000) }, true);
  await recordSecurityEvent(db, user.uid, 'sessions_revoked', { provider: user.provider, device });
  return json({ ok: true });
});
