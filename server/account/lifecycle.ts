/**
 * Account lifecycle operations used by administrators: suspend, reactivate,
 * schedule deletion (recoverable for DELETION_GRACE_DAYS), restore, and
 * permanent purge.
 *
 * Enforcement of a suspension happens in three places:
 *  1. Firebase Auth: the account is disabled and its refresh tokens revoked,
 *     so it cannot sign in or renew a session.
 *  2. Firestore rules: users/{uid}.accountStatus must be 'active' and the
 *     session must have started after users/{uid}.sessionsValidAfter, so
 *     still-valid ID tokens stop working immediately.
 *  3. API: requireAllowedUser re-checks the same profile on every request.
 *
 * Deletion policy: everything stored under users/{uid} (profile, chats,
 * messages, memories, project memory, documents and their chunks, knowledge
 * base, usage, security events), the account's phone-number claim and code
 * records, its allowlist entries, and finally the Firebase Auth account.
 * Uploaded files live in Firestore (there is no Cloud Storage bucket), so
 * nothing is left behind elsewhere.
 */
import { deleteReportsOf } from '../support/reports.js';
import type { AccessConfig } from '../access.js';
import { accountAdmin, SERVER_UID, type AuthAccount } from '../admin.js';
import { phoneKey } from '../auth/otp.js';
import { env } from '../env.js';
import type { Firestore, Write } from '../firestore.js';
import { recordAdminAction, recordSecurityEvent, type AdminAction } from './events.js';

export const DELETION_GRACE_DAYS = 30;
export type AccountStatus = 'active' | 'suspended' | 'deleted';

export interface ProfileStatus {
  accountStatus?: AccountStatus;
  sessionsValidAfter?: number;
  suspendedAt?: string;
  deletionScheduledAt?: string;
  deletionStamp?: number | null;
  deletedBy?: 'admin' | 'user' | null;
  deletionReminderAt?: number | null;
  purgeAfter?: number;
  phoneNumber?: string | null;
  email?: string | null;
}

export interface Actor {
  uid: string;
  email: string | null;
}

const nowSec = (now: number) => Math.floor(now / 1000);

async function log(db: Firestore, action: AdminAction, actor: Actor, target: AuthAccount, detail?: string) {
  await recordAdminAction(db, { action, adminUid: actor.uid, adminEmail: actor.email, targetUid: target.uid, targetEmail: target.email, detail });
}

export async function suspendAccount(db: Firestore, actor: Actor, target: AuthAccount, reason: string | undefined, now = Date.now()) {
  const admin = accountAdmin();
  await admin.update(target.uid, { disabled: true, revokeSessions: true });
  await db.set(
    `users/${target.uid}`,
    { accountStatus: 'suspended', suspendedAt: new Date(now), suspendedReason: reason?.slice(0, 300) ?? null, sessionsValidAfter: nowSec(now) },
    true,
  );
  await recordSecurityEvent(db, target.uid, 'account_suspended', { by: 'admin' }, now);
  await log(db, 'user_suspended', actor, target, reason);
}

export async function reactivateAccount(db: Firestore, actor: Actor, target: AuthAccount, now = Date.now()) {
  await accountAdmin().update(target.uid, { disabled: false });
  await db.set(`users/${target.uid}`, { accountStatus: 'active', suspendedAt: null, suspendedReason: null, deletionScheduledAt: null, purgeAfter: null }, true);
  await recordSecurityEvent(db, target.uid, 'account_reactivated', { by: 'admin' }, now);
  await log(db, 'user_reactivated', actor, target);
}

/**
 * Disable the account now and delete it permanently after DELETION_GRACE_DAYS.
 * `by: 'user'` is the account holder deleting their own account from Settings
 * (api/account.ts checks a fresh email code first); it is still recorded in
 * the admin log so administrators can see it and restore it within the period.
 */
export async function scheduleDeletion(
  db: Firestore,
  actor: Actor,
  target: AuthAccount,
  now = Date.now(),
  by: 'admin' | 'user' = 'admin',
) {
  const purgeAfter = now + DELETION_GRACE_DAYS * 86_400_000;
  await accountAdmin().update(target.uid, { disabled: true, revokeSessions: true });
  await db.set(
    `users/${target.uid}`,
    {
      accountStatus: 'deleted',
      deletionScheduledAt: new Date(now),
      // binds the "Cancel deletion" link to this deletion (server/account/restore.ts)
      deletionStamp: now,
      deletedBy: by,
      deletionReminderAt: null,
      purgeAfter,
      sessionsValidAfter: nowSec(now),
      email: target.email,
    },
    true,
  );
  await recordSecurityEvent(db, target.uid, 'account_deletion_scheduled', { by }, now);
  const when = new Date(purgeAfter).toISOString().slice(0, 10);
  await log(db, 'user_deletion_scheduled', actor, target, by === 'user' ? `requested by the account holder; permanent deletion after ${when}` : `permanent deletion after ${when}`);
  return { purgeAfter };
}

/** `by: 'user'`: the account holder used the "Cancel deletion" link from the deletion email. */
export async function restoreAccount(
  db: Firestore,
  actor: Actor,
  target: AuthAccount,
  now = Date.now(),
  by: 'admin' | 'user' = 'admin',
) {
  await accountAdmin().update(target.uid, { disabled: false });
  await db.set(
    `users/${target.uid}`,
    { accountStatus: 'active', deletionScheduledAt: null, deletionStamp: null, deletedBy: null, deletionReminderAt: null, purgeAfter: null, suspendedAt: null },
    true,
  );
  await recordSecurityEvent(db, target.uid, 'account_restored', { by }, now);
  await log(db, 'user_restored', actor, target, by === 'user' ? 'cancelled by the account holder with the link in the deletion email' : undefined);
}

/** Delete a document and everything nested under it (including "missing" parents). */
/**
 * Every subcollection name that can exist under users/{uid}, at any depth.
 * Mirrors the match blocks in firebase/firestore.rules (a test keeps the two
 * in sync): clients cannot write anywhere else, and neither does the server.
 */
export const USER_COLLECTIONS = [
  'securityEvents',
  'consents',
  'notifications',
  'conversations',
  'messages',
  'memories',
  'documents',
  'chunks',
  'images',
  'summaries',
  'tables',
  'kbCollections',
  'kbSources',
  'index',
  'projects',
  'savedResponses',
  'usage',
  'memoryVectors',
  'convVectors',
  'searchCache',
  'projectMemory',
  'convIndex',
  // pictures created by Atlas AI: metadata and image bytes
  'generatedImages',
  'generatedImageData',
] as const;

/** Delete a user document and everything under it. Returns the number of documents removed. */
export async function deleteTree(db: Firestore, docPath: string, collections: readonly string[] = USER_COLLECTIONS): Promise<number> {
  let deleted = 0;
  for (const coll of collections) {
    // Each pass deletes what the query returned; stop when nothing is left.
    for (let guard = 0; guard < 1000; guard++) {
      const paths = await db.descendantPaths(docPath, coll, 400);
      if (!paths.length) break;
      await db.commit(paths.map((path) => ({ op: 'delete' as const, path })));
      deleted += paths.length;
    }
  }
  await db.delete(docPath);
  return deleted + 1;
}

/** Permanently remove an account and all of its data. Irreversible. */
export async function purgeAccount(db: Firestore, actor: Actor | null, target: AuthAccount): Promise<{ documents: number }> {
  const profile = (await db.get<ProfileStatus>(`users/${target.uid}`))?.data;
  const writes: Write[] = [
    { op: 'delete', path: `otp/${target.uid}` },
    { op: 'delete', path: `otpRecovery/${target.uid}` },
    { op: 'delete', path: `restoreRequests/${target.uid}` },
  ];
  const secret = env().otpSecret;
  if (profile?.phoneNumber && secret.length >= 32) {
    const owner = await db.get<{ uid: string }>(`phoneNumbers/${phoneKey(secret, profile.phoneNumber)}`);
    if (owner?.data.uid === target.uid) writes.push({ op: 'delete', path: owner.path });
  }
  // Remove the email from the allowlist, so a new account with this address is not approved automatically.
  const email = (target.email ?? profile?.email ?? null)?.toLowerCase() ?? null;
  const access = await db.get<AccessConfig>('config/access');
  if (email && access) {
    const drop = (list?: string[]) => (list ?? []).filter((e) => e.toLowerCase() !== email);
    const allowedEmails = drop(access.data.allowedEmails);
    const adminEmails = drop(access.data.adminEmails);
    if (allowedEmails.length !== (access.data.allowedEmails ?? []).length || adminEmails.length !== (access.data.adminEmails ?? []).length) {
      writes.push({ op: 'set', path: 'config/access', data: { allowedEmails, adminEmails }, merge: true });
    }
  }
  const smsLogs = await db.list('smsLog', { where: [['uid', 'EQUAL', target.uid]], limit: 500 });
  for (const l of smsLogs) await db.delete(l.path);
  // ElevenLabs request history (no text, but tied to the account)
  const voiceLogs = await db.list('elevenlabsRequests', { where: [['uid', 'EQUAL', target.uid]], limit: 500 });
  for (const l of voiceLogs) await db.delete(l.path);
  const documents = (await deleteTree(db, `users/${target.uid}`)) + (await deleteReportsOf(db, target.uid)) + smsLogs.length + voiceLogs.length;
  await db.commit(writes);
  if (await accountAdmin().get(target.uid)) await accountAdmin().remove(target.uid);
  if (actor) await log(db, 'user_purged', actor, target, `${documents} documents removed`);
  else await recordAdminAction(db, { action: 'user_purged', adminUid: 'system', adminEmail: null, targetUid: target.uid, targetEmail: target.email, detail: `scheduled purge, ${documents} documents removed` });
  return { documents };
}

/** Purge every account whose recovery period has ended (run daily by the cron job). */
export async function purgeDue(db: Firestore, now = Date.now()): Promise<{ purged: string[]; failed: string[] }> {
  const due = await db.list<ProfileStatus>('users', { where: [['accountStatus', 'EQUAL', 'deleted']], limit: 100 });
  const purged: string[] = [];
  const failed: string[] = [];
  for (const d of due) {
    if (d.id === SERVER_UID || !d.data.purgeAfter || d.data.purgeAfter > now) continue;
    try {
      const account = (await accountAdmin().get(d.id)) ?? ({ uid: d.id, email: d.data.email ?? null } as AuthAccount);
      if (account.disabled === false) continue; // restored in Auth but profile not updated: leave it alone
      await purgeAccount(db, null, account);
      purged.push(d.id);
    } catch (err) {
      console.error('[purge] failed for one account', err instanceof Error ? err.message : err);
      failed.push(d.id);
    }
  }
  return { purged, failed };
}
