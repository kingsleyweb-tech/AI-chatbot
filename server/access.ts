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
    return { user, db, admin: cached.admin };
  }
  if (!user.emailVerified) {
    throw new HttpError(403, 'email_unverified', 'Please verify your email address first.');
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
  return { user, db, admin: result.admin };
}
