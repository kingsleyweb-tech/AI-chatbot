/**
 * Access requests and administrator approval.
 *
 * Records (server-only writes; see firestore.rules):
 * - accessRequests/{uid}   one per Firebase account, so a person can never
 *                          create duplicates; resubmission is not possible
 *                          once reviewed (an administrator can delete it).
 * - users/{uid}.accessStatus  'pending' | 'approved' | 'rejected', the
 *                          approval itself. Phone verification
 *                          (phoneVerified) and suspension (accountStatus)
 *                          are separate fields.
 *
 * Only the server identity writes either, after checking the caller.
 */
import { accessConfig, clearAccessCache, decideAccess, type AccessConfig, type GateProfile, type GateState } from '../access.js';
import { phoneKey } from '../auth/otp.js';
import { maskPhone, normalizeInternational } from '../auth/phone.js';
import type { AuthUser } from '../auth.js';
import { env } from '../env.js';
import type { Firestore, Write } from '../firestore.js';
import { HttpError } from '../http.js';
import { recordAdminAction, recordSecurityEvent } from './events.js';
import type { Actor } from './lifecycle.js';

export type RequestStatus = 'pending' | 'approved' | 'rejected';

export interface HistoryEntry {
  status: 'submitted' | RequestStatus;
  at: number;
  by?: string | null;
  note?: string | null;
}

export interface AccessRequest {
  requestId: string;
  uid: string;
  fullName: string;
  email: string;
  emailNorm: string;
  phoneNumber: string | null;
  phoneNorm: string | null;
  authProvider: string;
  phoneVerified: boolean;
  reason: string | null;
  status: RequestStatus;
  submittedAt: number;
  updatedAt: number;
  reviewedAt?: number | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
  history: HistoryEntry[];
}

export interface ProfileForAccess extends GateProfile {
  email?: string | null;
  displayName?: string;
  photoURL?: string | null;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  provider?: string;
  createdAt?: unknown;
}

const lower = (list?: string[]) => (list ?? []).map((e) => e.toLowerCase());

/** What the signed-in person may see about their own request (no internal fields). */
export function ownRequestView(r: AccessRequest | undefined | null) {
  if (!r) return null;
  return {
    status: r.status,
    fullName: r.fullName,
    email: r.email,
    phoneMasked: r.phoneNumber ? maskPhone(r.phoneNumber) : null,
    phoneVerified: r.phoneVerified,
    reason: r.reason,
    submittedAt: r.submittedAt,
    reviewedAt: r.reviewedAt ?? null,
  };
}

/**
 * Make sure every signed-in person has a profile in Firestore (also those
 * who are not approved yet), and give older profiles an accessStatus:
 * approved when the legacy allowlist or admin list already grants access,
 * otherwise pending. Returns the profile as stored.
 */
export async function ensureProfile(db: Firestore, user: AuthUser, config: AccessConfig | null, name?: string): Promise<ProfileForAccess> {
  const path = `users/${user.uid}`;
  const existing = (await db.get<ProfileForAccess>(path))?.data;
  const decided = decideAccess({ ...user, emailVerified: true, phoneVerified: true }, existing, config, env().adminEmails);
  const legacyApproved = decided.state === 'approved';
  if (!existing) {
    const profile: ProfileForAccess & Record<string, unknown> = {
      uid: user.uid,
      email: user.email,
      displayName: (name || user.name || user.email?.split('@')[0] || 'User').slice(0, 100),
      photoURL: user.picture ?? null,
      provider: user.provider || 'unknown',
      emailVerified: user.emailVerified,
      accessStatus: legacyApproved ? 'approved' : 'pending',
      createdAt: new Date(),
      lastSeenAt: new Date(),
    };
    await db.commit([{ op: 'set', path, data: profile, precondition: { exists: false } }]).catch(async (err) => {
      // created concurrently by another request: fine
      if ((err as { status?: number }).status !== 409) throw err;
    });
    return profile;
  }
  const patch: Record<string, unknown> = {};
  if (!existing.accessStatus) patch.accessStatus = legacyApproved ? 'approved' : 'pending';
  if (!existing.email && user.email) patch.email = user.email;
  if (!existing.displayName && (name || user.name)) patch.displayName = (name || user.name)!.slice(0, 100);
  if (Object.keys(patch).length) await db.set(path, patch, true);
  return { ...existing, ...patch };
}

export interface RequestInput {
  fullName: string;
  phone?: string;
  dialCode?: string;
  reason?: string;
}

/**
 * Submit (or look up) the caller's access request. Only for the caller's own
 * signed-in identity: the email comes from the verified token, never from
 * the form. Password accounts use their verified phone number.
 */
export async function submitRequest(
  db: Firestore,
  user: AuthUser,
  input: RequestInput,
  now = Date.now(),
): Promise<{ state: GateState; request: AccessRequest | null; created: boolean }> {
  if (!user.email || !user.emailVerified) throw new HttpError(403, 'email_unverified', 'Please verify your email address first.');
  const config = await accessConfig(db, true);
  const profile = await ensureProfile(db, user, config, input.fullName);
  const reqPath = `accessRequests/${user.uid}`;
  const existing = (await db.get<AccessRequest>(reqPath))?.data ?? null;
  const gate = decideAccess(user, profile, config, env().adminEmails, existing);
  if (gate.state === 'phone') throw new HttpError(403, 'phone_unverified', 'Please verify your phone number first.');
  if (gate.state === 'suspended' || gate.state === 'deleted') throw new HttpError(403, 'account_suspended', 'This account is not active.');
  // Already approved, or a request already exists: never create a second one.
  if (gate.state === 'approved' || existing) return { state: gate.state, request: existing, created: false };

  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (fullName.length < 2 || fullName.length > 100) throw new HttpError(400, 'bad_name', 'Enter your full name.');
  const reason = input.reason?.trim().slice(0, 500) || null;

  let phone: string | null;
  let phoneVerified: boolean;
  if (user.provider === 'password') {
    phone = profile.phoneNumber ?? null;
    phoneVerified = Boolean(phone && profile.phoneVerified);
  } else {
    const n = normalizeInternational(input.phone ?? '', input.dialCode);
    if (!n.ok) throw new HttpError(400, 'bad_phone', 'Enter a valid phone number, including the country code.');
    phone = n.e164;
    phoneVerified = Boolean(profile.phoneVerified && profile.phoneNumber === phone);
  }

  // The same email or phone may not be pending under another account.
  const email = user.email.toLowerCase();
  const sameEmail = await db.list<AccessRequest>('accessRequests', { where: [['emailNorm', 'EQUAL', email]], limit: 5 });
  const samePhone = phone ? await db.list<AccessRequest>('accessRequests', { where: [['phoneNorm', 'EQUAL', phone]], limit: 5 }) : [];
  if ([...sameEmail, ...samePhone].some((d) => d.id !== user.uid && d.data.status !== 'rejected')) {
    throw new HttpError(409, 'duplicate_request', 'A request with this email address or phone number already exists. Sign in with the account you used before.');
  }
  if (phone && env().otpSecret.length >= 32) {
    const owner = await db.get<{ uid: string }>(`phoneNumbers/${phoneKey(env().otpSecret, phone)}`);
    if (owner && owner.data.uid !== user.uid) throw new HttpError(409, 'phone_in_use', 'This phone number is already linked to another account.');
  }

  const request: AccessRequest = {
    requestId: user.uid,
    uid: user.uid,
    fullName,
    email,
    emailNorm: email,
    phoneNumber: phone,
    phoneNorm: phone,
    authProvider: user.provider,
    phoneVerified,
    reason,
    status: 'pending',
    submittedAt: now,
    updatedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    history: [{ status: 'submitted', at: now }],
  };
  const writes: Write[] = [
    { op: 'set', path: reqPath, data: request, precondition: { exists: false } },
    {
      op: 'set',
      path: `users/${user.uid}`,
      data: { accessStatus: 'pending', accessRequestedAt: now, ...(profile.displayName ? {} : { displayName: fullName }) },
      merge: true,
    },
  ];
  try {
    await db.commit(writes);
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
    // submitted twice at the same moment: return the one that won
    const won = (await db.get<AccessRequest>(reqPath))?.data ?? null;
    return { state: 'pending', request: won, created: false };
  }
  await recordSecurityEvent(db, user.uid, 'access_requested', { provider: user.provider });
  return { state: 'pending', request, created: true };
}

/**
 * Administrator decision. Approval sets users/{uid}.accessStatus, which the
 * rules and every API check, so access starts on the user's next request
 * (no new account, no token change needed). Rejection also removes the
 * email from the legacy allowlist so it cannot grant access again.
 */
export async function setAccess(
  db: Firestore,
  actor: Actor,
  target: { uid: string; email: string | null },
  decision: 'approve' | 'reject',
  note?: string,
  now = Date.now(),
): Promise<void> {
  const reqPath = `accessRequests/${target.uid}`;
  const [request, config] = await Promise.all([db.get<AccessRequest>(reqPath), accessConfig(db, true)]);
  const status: RequestStatus = decision === 'approve' ? 'approved' : 'rejected';
  const by = actor.email ?? actor.uid;
  const writes: Write[] = [
    {
      op: 'set',
      path: `users/${target.uid}`,
      data:
        decision === 'approve'
          ? { accessStatus: 'approved', approvedAt: now, approvedBy: by, rejectedAt: null, rejectedBy: null }
          : { accessStatus: 'rejected', rejectedAt: now, rejectedBy: by, approvedAt: null, approvedBy: null },
      merge: true,
    },
  ];
  if (request) {
    writes.push({
      op: 'set',
      path: reqPath,
      data: {
        status,
        reviewedAt: now,
        reviewedBy: by,
        reviewNote: note?.slice(0, 300) ?? null,
        updatedAt: now,
        history: [...(request.data.history ?? []), { status, at: now, by, note: note?.slice(0, 300) ?? null }].slice(-20),
      },
      merge: true,
    });
  }
  const email = target.email?.toLowerCase();
  if (decision === 'reject' && email && lower(config?.allowedEmails).includes(email)) {
    writes.push({
      op: 'set',
      path: 'config/access',
      data: { allowedEmails: lower(config?.allowedEmails).filter((e) => e !== email), adminEmails: config?.adminEmails ?? [], updatedAt: new Date(now) },
      merge: true,
    });
  }
  await db.commit(writes);
  clearAccessCache();
  await recordAdminAction(db, {
    action: request ? (decision === 'approve' ? 'request_approved' : 'request_rejected') : decision === 'approve' ? 'user_approved' : 'user_unapproved',
    adminUid: actor.uid,
    adminEmail: actor.email,
    targetUid: target.uid,
    targetEmail: target.email,
    detail: note,
  }, now);
  await recordSecurityEvent(db, target.uid, decision === 'approve' ? 'access_approved' : 'access_rejected', { by: 'admin' }, now);
}

/** Remove a request (spam, mistakes). The account itself is untouched; the person may submit again. */
export async function deleteRequest(db: Firestore, actor: Actor, targetUid: string, now = Date.now()): Promise<void> {
  const request = await db.get<AccessRequest>(`accessRequests/${targetUid}`);
  if (!request) throw new HttpError(404, 'not_found', 'Request not found.');
  await db.delete(request.path);
  await recordAdminAction(db, { action: 'request_deleted', adminUid: actor.uid, adminEmail: actor.email, targetUid, targetEmail: request.data.email }, now);
}

export interface AdminRequestRow {
  uid: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  authProvider: string;
  phoneVerified: boolean;
  reason: string | null;
  status: RequestStatus;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  history: HistoryEntry[];
  /** current state of the account behind the request */
  accountStatus: string;
  accessStatus: string;
}

export function requestStats(rows: Pick<AdminRequestRow, 'status' | 'submittedAt'>[], now = Date.now()) {
  const week = now - 7 * 86_400_000;
  return {
    total: rows.length,
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    recent: rows.filter((r) => r.submittedAt >= week).length,
  };
}

/** Every request with the linked account's current state, newest first. */
export async function listRequests(db: Firestore): Promise<AdminRequestRow[]> {
  const [requests, profiles] = await Promise.all([
    db.list<AccessRequest>('accessRequests', { limit: 2000 }),
    db.list<ProfileForAccess>('users', { limit: 2500 }),
  ]);
  const byUid = new Map(profiles.map((p) => [p.id, p.data]));
  return requests
    .map(({ id, data: r }) => {
      const p = byUid.get(id);
      return {
        uid: id,
        fullName: r.fullName,
        email: r.email,
        phoneNumber: r.phoneNumber,
        authProvider: r.authProvider,
        phoneVerified: Boolean(r.phoneVerified || (p?.phoneVerified && p.phoneNumber && p.phoneNumber === r.phoneNumber)),
        reason: r.reason,
        status: r.status,
        submittedAt: r.submittedAt,
        reviewedAt: r.reviewedAt ?? null,
        reviewedBy: r.reviewedBy ?? null,
        reviewNote: r.reviewNote ?? null,
        history: r.history ?? [],
        accountStatus: p?.accountStatus ?? 'active',
        accessStatus: p?.accessStatus ?? 'pending',
      };
    })
    .sort((a, b) => b.submittedAt - a.submittedAt);
}
