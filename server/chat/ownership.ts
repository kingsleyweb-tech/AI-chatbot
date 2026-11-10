/**
 * Ownership record: who created and owns Atlas AI. The default comes from
 * server/shared/identity.ts. The Super Admin (an owner account listed in the
 * server's ADMIN_EMAILS, with a verified email) can replace it from the admin
 * console. That needs a sign-in from the last 10 minutes, the typed
 * confirmation phrase, their own email address and a reason. Every change is
 * written to identityAudit together with the record, in one commit.
 *
 * Both documents are server-only: firebase/firestore.rules denies every client
 * read and write of config/{other} and of collections it doesn't list. Nothing
 * said in a chat, saved in a profile, memory or document can change the record:
 * the chat engine only reads it.
 */
import { trustedDb } from '../admin.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { ATLAS_IDENTITY } from '../shared/identity.js';

export const IDENTITY_PATH = 'config/identity';
export const IDENTITY_AUDIT = 'identityAudit';
export const OWNERSHIP_CONFIRM = 'CHANGE OWNERSHIP';
/** how recent the Super Admin's sign-in must be to change the record (seconds) */
export const REAUTH_WINDOW_S = 10 * 60;

export interface OwnershipRecord {
  creator: string;
  owner: string;
  aliases: string[];
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export function defaultOwnership(): OwnershipRecord {
  return {
    creator: ATLAS_IDENTITY.creator,
    owner: ATLAS_IDENTITY.owner,
    aliases: [...ATLAS_IDENTITY.aliases],
    version: 0,
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * A person's or organisation's name: letters, spaces and a little punctuation.
 * No digits, brackets, colons or line breaks, so the record can't carry
 * instructions into the system prompt.
 */
const NAME = /^\p{L}[\p{L}\p{M} .,'&-]{0,78}[\p{L}.]$/u;

export function validName(v: unknown): v is string {
  return typeof v === 'string' && NAME.test(v.trim()) && !/\s{2,}/.test(v.trim());
}

export function normalizeOwnership(raw: unknown): OwnershipRecord {
  const d = defaultOwnership();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!validName(r.creator) || !validName(r.owner)) return d;
  const aliases = Array.isArray(r.aliases) ? r.aliases.filter(validName).map((a) => a.trim()).slice(0, 5) : [];
  return {
    creator: r.creator.trim(),
    owner: r.owner.trim(),
    aliases,
    version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : 0,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : null,
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy.slice(0, 200) : null,
  };
}

let cache: { at: number; value: OwnershipRecord } | null = null;
export function resetOwnershipCache() {
  cache = null;
}

/** The current record (60 s cache). Falls back to the default when it can't be read. */
export async function loadOwnership(db: Firestore, fresh = false): Promise<OwnershipRecord> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  let value = defaultOwnership();
  try {
    const trusted = await trustedDb(db);
    value = normalizeOwnership((await trusted.get(IDENTITY_PATH))?.data ?? null);
  } catch {
    // unreadable (rules, network): the default record
  }
  cache = { at: Date.now(), value };
  return value;
}

export interface OwnershipCaller {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** seconds since epoch, from the ID token */
  authTime: number;
}

export interface OwnershipChange {
  creator: string;
  owner: string;
  aliases?: string[];
  reason: string;
  confirmPhrase: string;
  confirmEmail: string;
}

/** Whether the caller is the Super Admin: an owner email from the server configuration, verified. */
export function isSuperAdmin(caller: Pick<OwnershipCaller, 'email' | 'emailVerified'>, ownerEmails: string[]): boolean {
  const e = caller.email?.toLowerCase();
  return Boolean(e && caller.emailVerified && ownerEmails.map((o) => o.toLowerCase()).includes(e));
}

/** Every check a change has to pass, in order. Throws an HttpError with a clear reason. */
export function assertOwnershipChange(caller: OwnershipCaller, ownerEmails: string[], change: OwnershipChange, now = Date.now()) {
  if (!isSuperAdmin(caller, ownerEmails))
    throw new HttpError(403, 'not_super_admin', 'Only the Super Admin can change the ownership record.');
  if (!caller.authTime || now / 1000 - caller.authTime > REAUTH_WINDOW_S)
    throw new HttpError(401, 'reauth_required', 'Confirm it’s you by signing in again, then retry within 10 minutes.');
  if (change.confirmPhrase.trim() !== OWNERSHIP_CONFIRM)
    throw new HttpError(400, 'confirm_phrase', `Type ${OWNERSHIP_CONFIRM} to confirm.`);
  if (change.confirmEmail.trim().toLowerCase() !== caller.email?.toLowerCase())
    throw new HttpError(400, 'confirm_mismatch', 'The email address does not match your account.');
  if (!validName(change.creator) || !validName(change.owner))
    throw new HttpError(400, 'bad_name', 'Use a name of 2 to 80 letters, without numbers or symbols.');
  if ((change.aliases ?? []).some((a) => !validName(a)))
    throw new HttpError(400, 'bad_name', 'Each alternative name must be 2 to 80 letters, without numbers or symbols.');
  if (change.reason.trim().length < 10)
    throw new HttpError(400, 'reason_required', 'Give a reason of at least 10 characters for the audit log.');
}

/** Checks, then writes the new record and its audit entry in one commit. */
export async function changeOwnership(
  db: Firestore,
  caller: OwnershipCaller,
  ownerEmails: string[],
  change: OwnershipChange,
  meta: { userAgent?: string | null } = {},
  now = Date.now(),
): Promise<OwnershipRecord> {
  assertOwnershipChange(caller, ownerEmails, change, now);
  const before = await loadOwnership(db, true);
  const after: OwnershipRecord = {
    creator: change.creator.trim(),
    owner: change.owner.trim(),
    aliases: (change.aliases ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 5),
    version: before.version + 1,
    updatedAt: now,
    updatedBy: caller.email,
  };
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await db.commit([
    { op: 'set', path: IDENTITY_PATH, data: after },
    {
      op: 'set',
      path: `${IDENTITY_AUDIT}/${id}`,
      data: {
        at: now,
        actorUid: caller.uid,
        actorEmail: caller.email,
        action: 'ownership_change',
        before: { creator: before.creator, owner: before.owner, aliases: before.aliases, version: before.version },
        after: { creator: after.creator, owner: after.owner, aliases: after.aliases, version: after.version },
        reason: change.reason.trim().slice(0, 500),
        reauthenticatedAt: caller.authTime * 1000,
        userAgent: (meta.userAgent ?? '').slice(0, 200),
      },
    },
  ]);
  cache = { at: Date.now(), value: after };
  return after;
}

export interface OwnershipAuditEntry {
  id: string;
  at: number;
  actorEmail: string | null;
  before: { creator: string; owner: string };
  after: { creator: string; owner: string };
  reason: string;
}

export async function ownershipAudit(db: Firestore, limit = 20): Promise<OwnershipAuditEntry[]> {
  const rows = await db.list<Record<string, unknown>>(IDENTITY_AUDIT, { orderBy: 'at', direction: 'DESCENDING', limit });
  return rows.map((r) => {
    const d = r.data;
    const pick = (v: unknown) => {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return { creator: String(o.creator ?? ''), owner: String(o.owner ?? '') };
    };
    return {
      id: r.id,
      at: typeof d.at === 'number' ? d.at : 0,
      actorEmail: typeof d.actorEmail === 'string' ? d.actorEmail : null,
      before: pick(d.before),
      after: pick(d.after),
      reason: typeof d.reason === 'string' ? d.reason : '',
    };
  });
}
