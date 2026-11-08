import { adminConfigured, adminDb } from './admin.js';
import { needsPhone, requireUser, type AuthUser } from './auth.js';
import { env } from './env.js';
import { Firestore } from './firestore.js';
import { HttpError } from './http.js';

export interface AccessConfig {
  allowedEmails?: string[];
  adminEmails?: string[];
}

const cache = new Map<string, { ok: boolean; admin: boolean; at: number }>();
const TTL = 5 * 60_000;

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

export interface Ctx {
  user: AuthUser;
  db: Firestore;
  admin: boolean;
}

/**
 * Authenticate + authorize. Mirrors the Firestore rules: the user must have a
 * verified email that is either a bootstrap admin or on config/access.
 */
export async function requireAllowedUser(request: Request): Promise<Ctx> {
  const user = await requireUser(request);
  if (needsPhone(user)) {
    throw new HttpError(403, 'phone_unverified', 'Please verify your phone number first.');
  }
  const db = new Firestore(user.token);
  const cached = cache.get(user.uid);
  if (cached && Date.now() - cached.at < TTL) {
    if (!cached.ok) throw new HttpError(403, 'not_allowed', 'This account is not approved.');
    await assertAccountActive(user, db);
    return { user, db, admin: cached.admin };
  }
  if (!user.emailVerified) {
    throw new HttpError(403, 'email_unverified', 'Please verify your email address first.');
  }
  let config: AccessConfig | null = null;
  let denied = false;
  try {
    config = (await db.get<AccessConfig>('config/access'))?.data ?? null;
  } catch (err) {
    // A non-allowed user is denied reading config/access by the rules,
    // and so is an approved one whose account is suspended or session revoked.
    if (!(err instanceof HttpError && err.status === 403)) throw err;
    denied = true;
  }
  if (denied && adminConfigured()) {
    const real = (await (await adminDb()).get<AccessConfig>('config/access').catch(() => null))?.data ?? null;
    if (evaluateAccess(user.email, user.emailVerified, real, env().adminEmails).ok) {
      // approved, so the refusal came from the account state: report that instead
      await assertAccountActive(user, db);
      throw new HttpError(403, 'not_allowed', 'This account is not approved.');
    }
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
  if (profile.accountStatus === 'suspended') return new HttpError(403, 'account_suspended', 'This account has been suspended. Contact the administrator.');
  if (profile.accountStatus === 'deleted') return new HttpError(403, 'account_deleted', 'This account has been deleted.');
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
    const block = accountBlock((await db.get<ProfileGate>(`users/${user.uid}`))?.data, user.authTime);
    if (block) throw block;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 403 || err.code !== 'forbidden') throw err;
    cache.delete(user.uid);
    if (adminConfigured()) {
      const profile = (await (await adminDb()).get<ProfileGate>(`users/${user.uid}`).catch(() => null))?.data;
      const block = accountBlock(profile, user.authTime);
      if (block) throw block;
    }
    throw new HttpError(403, 'not_allowed', 'This account is not approved.');
  }
}
