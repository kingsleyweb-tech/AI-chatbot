import { adminConfigured, adminDb } from './admin.js';
import { needsPhone, requireUser, type AuthUser } from './auth.js';
import { env } from './env.js';
import { Firestore } from './firestore.js';
import { HttpError } from './http.js';
import { consentCurrent, type ConsentRecord } from './shared/legal.js';

export interface AccessConfig {
  allowedEmails?: string[];
  adminEmails?: string[];
}

/** config/approval: written only by the server (api/admin setAutoApprove), read by administrators. */
export interface ApprovalConfig {
  autoApprove?: boolean;
  updatedAt?: number;
  updatedBy?: string | null;
}

const cache = new Map<string, { ok: boolean; admin: boolean; at: number }>();
const TTL = 60_000;

export function evaluateAccess(
  email: string | null,
  verified: boolean,
  config: AccessConfig | null,
  bootstrapAdmins: string[],
): { ok: boolean; admin: boolean } {
  if (!email || !verified) return { ok: false, admin: false };
  const e = email.toLowerCase();
  const admins = [...bootstrapAdmins, ...(config?.adminEmails ?? [])].map((s) => s.toLowerCase());
  const allowed = (config?.allowedEmails ?? []).map((s) => s.toLowerCase());
  const admin = admins.includes(e);
  return { ok: admin || allowed.includes(e), admin };
}

/** Administrator approval of an account (independent of phone verification and suspension). */
export type AccessStatus = 'pending' | 'approved' | 'rejected';

/**
 * Where an account stands, in the order the checks apply:
 * phone       email/password account without a verified phone number
 * unverified  email address not verified and no verified phone number either
 *             (an account with a verified phone may use the app before
 *             verifying its email; sensitive actions call requireVerifiedEmail)
 * suspended   suspended by an administrator
 * deleted     scheduled for deletion
 * consent     the current Terms of Use and Privacy Policy are not accepted yet
 * approved    full access
 * rejected    an administrator declined access
 * pending     an access request is waiting for review
 * request     not approved and no request submitted yet
 */
export type GateState =
  | 'phone'
  | 'unverified'
  | 'suspended'
  | 'deleted'
  | 'consent'
  | 'approved'
  | 'rejected'
  | 'pending'
  | 'request';

export interface GateProfile {
  accountStatus?: string;
  sessionsValidAfter?: number;
  accessStatus?: string;
  consent?: Partial<ConsentRecord> | null;
}

export function decideAccess(
  user: Pick<AuthUser, 'email' | 'emailVerified' | 'provider' | 'phoneVerified'>,
  profile: GateProfile | undefined,
  config: AccessConfig | null,
  bootstrapAdmins: string[],
  request?: { status?: string } | null,
  opts: { ignoreConsent?: boolean } = {},
): { state: GateState; admin: boolean } {
  if (needsPhone(user)) return { state: 'phone', admin: false };
  if (!user.email || (!user.emailVerified && !user.phoneVerified))
    return { state: 'unverified', admin: false };
  if (profile?.accountStatus === 'suspended') return { state: 'suspended', admin: false };
  if (profile?.accountStatus === 'deleted') return { state: 'deleted', admin: false };
  // Everyone, administrators included, accepts the current documents first. Acceptance never
  // overrides a suspension (above) or a rejection (below: approval is decided separately).
  if (!opts.ignoreConsent && !consentCurrent(profile?.consent))
    return { state: 'consent', admin: false };
  // Administrator and allowlist entries match only a verified address: an unverified
  // account must never inherit the rights of an email it has not proved it owns.
  const legacy = evaluateAccess(user.email, user.emailVerified, config, bootstrapAdmins);
  if (legacy.admin) return { state: 'approved', admin: true };
  if (profile?.accessStatus === 'rejected') return { state: 'rejected', admin: false };
  if (profile?.accessStatus === 'approved' || legacy.ok) return { state: 'approved', admin: false };
  if (request?.status === 'rejected') return { state: 'rejected', admin: false };
  if (request?.status === 'pending') return { state: 'pending', admin: false };
  return { state: 'request', admin: false };
}

export interface Ctx {
  user: AuthUser;
  db: Firestore;
  admin: boolean;
}

let configCache: { value: AccessConfig | null; at: number } | null = null;
let approvalCache: { value: ApprovalConfig | null; at: number } | null = null;
const CONFIG_TTL = 60_000;

/** config/access read with the server identity, shared briefly across requests. */
export async function accessConfig(sdb: Firestore, fresh = false): Promise<AccessConfig | null> {
  if (!fresh && configCache && Date.now() - configCache.at < CONFIG_TTL) return configCache.value;
  const value = (await sdb.get<AccessConfig>('config/access'))?.data ?? null;
  configCache = { value, at: Date.now() };
  return value;
}
/** config/approval (automatic approval), same short cache; `fresh` for decisions that create accounts. */
export async function approvalConfig(
  sdb: Firestore,
  fresh = false,
): Promise<ApprovalConfig | null> {
  if (!fresh && approvalCache && Date.now() - approvalCache.at < CONFIG_TTL)
    return approvalCache.value;
  const value = (await sdb.get<ApprovalConfig>('config/approval'))?.data ?? null;
  approvalCache = { value, at: Date.now() };
  return value;
}

export function clearAccessCache() {
  configCache = null;
  approvalCache = null;
  cache.clear();
}

function denied(state: GateState): HttpError {
  if (state === 'pending')
    return new HttpError(
      403,
      'access_pending',
      'Your access request is waiting for administrator approval.',
    );
  if (state === 'rejected')
    return new HttpError(
      403,
      'access_rejected',
      'Access to Atlas AI was not approved for this account.',
    );
  if (state === 'consent')
    return new HttpError(
      403,
      'consent_required',
      'Please accept the Terms of Use and Privacy Policy to continue.',
    );
  return new HttpError(403, 'not_allowed', 'This account is not approved.');
}

/**
 * Authenticate + authorize every protected API call. The account must have
 * a verified email or a verified phone (and a verified phone for password
 * sign-ins), must not
 * be suspended, deleted or signed out, and must be approved by an
 * administrator: users/{uid}.accessStatus == 'approved', an admin, or an
 * email on the legacy allowlist (config/access). The Firestore rules apply
 * the same conditions to every database read and write.
 */
export async function requireAllowedUser(request: Request): Promise<Ctx> {
  const user = await requireUser(request);
  if (needsPhone(user)) {
    throw new HttpError(403, 'phone_unverified', 'Please verify your phone number first.');
  }
  if (!user.emailVerified && !user.phoneVerified) {
    throw new HttpError(403, 'email_unverified', 'Please verify your email address first.');
  }
  const db = new Firestore(user.token);
  if (adminConfigured()) {
    try {
      const sdb = await adminDb();
      const [profile, config] = await Promise.all([
        sdb.get<GateProfile>(`users/${user.uid}`),
        accessConfig(sdb),
      ]);
      const block = accountBlock(profile?.data, user.authTime);
      if (block) throw block;
      const r = decideAccess(user, profile?.data, config, env().adminEmails);
      if (r.state !== 'approved') throw denied(r.state);
      return { user, db, admin: r.admin };
    } catch (err) {
      // The server identity is unavailable (rules not published yet): fall back to the user's own token.
      if (
        !(err instanceof HttpError) ||
        !['admin_unconfigured', 'admin_unavailable'].includes(err.code)
      )
        throw err;
    }
  }
  return legacyAccess(user, db);
}

/** Sensitive actions (password, sign-in methods, phone number, data export…) need a verified email. */
export function requireVerifiedEmail(user: Pick<AuthUser, 'emailVerified'>): void {
  if (!user.emailVerified)
    throw new HttpError(
      403,
      'email_unverified',
      'Verify your email address first. You can do it in Settings › Security.',
    );
}

async function legacyAccess(user: AuthUser, db: Firestore): Promise<Ctx> {
  const cached = cache.get(user.uid);
  if (cached && Date.now() - cached.at < TTL) {
    if (!cached.ok) throw new HttpError(403, 'not_allowed', 'This account is not approved.');
    await assertAccountActive(user, db);
    return { user, db, admin: cached.admin };
  }
  let config: AccessConfig | null = null;
  try {
    config = (await db.get<AccessConfig>('config/access'))?.data ?? null;
  } catch (err) {
    // A non-allowed user is denied reading config/access by the rules.
    if (!(err instanceof HttpError && err.status === 403)) throw err;
  }
  const result = evaluateAccess(user.email, user.emailVerified, config, env().adminEmails);
  cache.set(user.uid, { ...result, at: Date.now() });
  if (!result.ok) throw new HttpError(403, 'not_allowed', 'This account is not approved.');
  await assertAccountActive(user, db);
  return { user, db, admin: result.admin };
}

interface ProfileGate {
  accountStatus?: string;
  sessionsValidAfter?: number;
}

/** Why an approved account's profile is unreadable: suspended, deleted, or a revoked session. */
export function accountBlock(profile: ProfileGate | undefined, authTime: number): HttpError | null {
  if (!profile) return null;
  if (profile.accountStatus === 'suspended')
    return new HttpError(
      403,
      'account_suspended',
      'This account has been suspended. Contact the administrator.',
    );
  if (profile.accountStatus === 'deleted')
    return new HttpError(403, 'account_deleted', 'This account has been deleted.');
  if (profile.sessionsValidAfter && authTime < profile.sessionsValidAfter) {
    return new HttpError(401, 'session_revoked', 'You were signed out. Please sign in again.');
  }
  return null;
}

/**
 * Suspension and session revocation take effect immediately: the security
 * rules refuse the profile read for a suspended account or a session that
 * started before sessionsValidAfter, and this check runs on every request.
 */
async function assertAccountActive(user: AuthUser, db: Firestore): Promise<void> {
  try {
    const block = accountBlock(
      (await db.get<ProfileGate>(`users/${user.uid}`))?.data,
      user.authTime,
    );
    if (block) throw block;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 403 || err.code !== 'forbidden') throw err;
    cache.delete(user.uid);
    if (adminConfigured()) {
      const profile = (
        await (await adminDb()).get<ProfileGate>(`users/${user.uid}`).catch(() => null)
      )?.data;
      const block = accountBlock(profile, user.authTime);
      if (block) throw block;
    }
    throw new HttpError(403, 'not_allowed', 'This account is not approved.');
  }
}
