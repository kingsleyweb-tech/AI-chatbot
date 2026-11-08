import { z } from 'zod';
import { requireAllowedUser, type AccessConfig } from '../server/access.js';
import { recordAdminAction } from '../server/account/events.js';
import {
  purgeAccount,
  purgeDue,
  reactivateAccount,
  restoreAccount,
  scheduleDeletion,
  suspendAccount,
  type Actor,
  type ProfileStatus,
} from '../server/account/lifecycle.js';
import { accountAdmin, adminConfigured, adminDb, type AuthAccount } from '../server/admin.js';
import { maskPhone } from '../server/auth/phone.js';
import { env } from '../server/env.js';
import type { Firestore } from '../server/firestore.js';
import { handle, HttpError, json, readJson } from '../server/http.js';

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('detail'), uid }),
  z.object({ action: z.literal('suspend'), uid, reason: z.string().max(300).optional() }),
  z.object({ action: z.literal('reactivate'), uid }),
  z.object({ action: z.literal('delete'), uid, confirmEmail: z.string().max(320) }),
  z.object({ action: z.literal('restore'), uid }),
  z.object({ action: z.literal('purge'), uid, confirmEmail: z.string().max(320), acknowledge: z.literal(true) }),
  z.object({ action: z.literal('approve'), uid, approved: z.boolean() }),
  z.object({ action: z.literal('logs') }),
]);

interface Profile extends ProfileStatus {
  displayName?: string;
  photoURL?: string | null;
  phoneVerified?: boolean;
  lastLoginAt?: string;
}

export interface AdminUserRow {
  uid: string;
  email: string | null;
  name: string;
  photoURL: string | null;
  providers: string[];
  createdAt: number | null;
  lastLoginAt: number | null;
  status: 'active' | 'suspended' | 'deleted';
  phoneMasked: string | null;
  phoneVerified: boolean;
  emailVerified: boolean;
  approved: boolean;
  admin: boolean;
  owner: boolean;
  purgeAfter: number | null;
}

const NEW_DAYS = 7;

function lower(list?: string[]) {
  return (list ?? []).map((e) => e.toLowerCase());
}

function row(a: AuthAccount, p: Profile | undefined, access: AccessConfig | null): AdminUserRow {
  const owners = lower(env().adminEmails);
  const admins = [...owners, ...lower(access?.adminEmails)];
  const email = a.email ?? null;
  const status = p?.accountStatus === 'deleted' ? 'deleted' : p?.accountStatus === 'suspended' || (a.disabled && p?.accountStatus !== 'active') ? 'suspended' : 'active';
  return {
    uid: a.uid,
    email,
    name: p?.displayName || a.displayName || email?.split('@')[0] || 'Unnamed',
    photoURL: p?.photoURL ?? a.photoURL,
    providers: a.providers,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt,
    status,
    phoneMasked: p?.phoneNumber ? maskPhone(p.phoneNumber) : null,
    phoneVerified: a.claims.phoneVerified === true && Boolean(p?.phoneNumber),
    emailVerified: a.emailVerified,
    approved: Boolean(email && (admins.includes(email) || lower(access?.allowedEmails).includes(email))),
    admin: Boolean(email && admins.includes(email)),
    owner: Boolean(email && owners.includes(email)),
    purgeAfter: status === 'deleted' ? (p?.purgeAfter ?? null) : null,
  };
}

/** Statistics computed from the actual records (never sample data). */
export function stats(rows: AdminUserRow[], now = Date.now()) {
  const recent = now - NEW_DAYS * 86_400_000;
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    suspended: rows.filter((r) => r.status === 'suspended').length,
    pendingDeletion: rows.filter((r) => r.status === 'deleted').length,
    newUsers: rows.filter((r) => (r.createdAt ?? 0) >= recent).length,
    newDays: NEW_DAYS,
    google: rows.filter((r) => r.providers.includes('google.com')).length,
    password: rows.filter((r) => r.providers.includes('password')).length,
    phoneVerified: rows.filter((r) => r.phoneVerified).length,
    phoneUnverified: rows.filter((r) => !r.phoneVerified).length,
    /** password accounts that cannot use the app until they verify a phone */
    phoneRequiredPending: rows.filter((r) => r.providers.includes('password') && !r.phoneVerified).length,
  };
}

async function loadTarget(db: Firestore, targetUid: string) {
  const account = await accountAdmin().get(targetUid);
  if (!account) throw new HttpError(404, 'not_found', 'User not found.');
  const access = (await db.get<AccessConfig>('config/access'))?.data ?? null;
  const profile = (await db.get<Profile>(`users/${targetUid}`))?.data;
  return { account, access, profile, row: row(account, profile, access) };
}

/** Administrators cannot act on themselves or the owner; only the owner can act on other admins. */
function assertCanModerate(actor: Actor, actorIsOwner: boolean, target: AdminUserRow) {
  if (target.uid === actor.uid) throw new HttpError(400, 'self', 'You cannot do this to your own account.');
  if (target.owner) throw new HttpError(403, 'owner', 'The owner account cannot be suspended or deleted.');
  if (target.admin && !actorIsOwner) throw new HttpError(403, 'admin_target', 'Only the owner can suspend or delete another administrator.');
}

function assertConfirmed(target: AdminUserRow, confirmEmail: string) {
  const expected = (target.email ?? target.uid).toLowerCase();
  if (confirmEmail.trim().toLowerCase() !== expected) throw new HttpError(400, 'confirm_mismatch', 'The confirmation does not match this account.');
}

async function usageSummary(db: Firestore, targetUid: string) {
  const days = await db.list<{ date?: string; requests?: number; promptTokens?: number; completionTokens?: number; models?: Record<string, { requests?: number; tokens?: number }> }>(
    `users/${targetUid}/usage`,
    { orderBy: 'date', direction: 'DESCENDING', limit: 30 },
  );
  const models: Record<string, { requests: number; tokens: number }> = {};
  let requests = 0;
  let tokens = 0;
  for (const d of days) {
    requests += d.data.requests ?? 0;
    tokens += (d.data.promptTokens ?? 0) + (d.data.completionTokens ?? 0);
    for (const [m, v] of Object.entries(d.data.models ?? {})) {
      models[m] ??= { requests: 0, tokens: 0 };
      models[m].requests += v.requests ?? 0;
      models[m].tokens += v.tokens ?? 0;
    }
  }
  const topModels = Object.entries(models)
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 6)
    .map(([model, v]) => ({ model, ...v }));
  return { days: days.length, requests, tokens, activeDays: days.filter((d) => (d.data.requests ?? 0) > 0).length, lastActive: days[0]?.data.date ?? null, topModels };
}

/**
 * Daily job (Vercel Cron, see vercel.json): permanently delete accounts whose
 * recovery period has ended. Vercel sends "Authorization: Bearer $CRON_SECRET".
 */
export const GET = handle(async (request) => {
  const secret = process.env.CRON_SECRET ?? '';
  if (new URL(request.url).searchParams.get('job') !== 'purge') throw new HttpError(404, 'not_found', 'Not found.');
  if (secret.length < 16 || request.headers.get('authorization') !== `Bearer ${secret}`) throw new HttpError(401, 'unauthenticated', 'Not allowed.');
  if (!adminConfigured()) throw new HttpError(503, 'admin_unconfigured', 'Service account not configured.');
  const result = await purgeDue(await adminDb());
  return json({ ok: true, purged: result.purged.length, failed: result.failed.length });
});

/**
 * Administrator user management. Authorization is decided on the server:
 * the caller must be an approved administrator (bootstrap owner or listed in
 * config/access.adminEmails, which only admins can change). Privileged reads
 * and writes use the service account; responses never contain passwords,
 * codes, tokens, full phone numbers or conversation content.
 */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  if (!ctx.admin) throw new HttpError(403, 'not_admin', 'Administrator access is required.');
  if (!adminConfigured()) throw new HttpError(503, 'admin_unconfigured', 'User management needs FIREBASE_SERVICE_ACCOUNT on the server.');
  const parsed = schema.safeParse(await readJson(request, 5_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  const db = await adminDb();
  const actor: Actor = { uid: ctx.user.uid, email: ctx.user.email };
  const actorIsOwner = lower(env().adminEmails).includes(ctx.user.email ?? '');

  if (b.action === 'list') {
    const [accounts, profiles, access] = await Promise.all([
      accountAdmin().list(),
      db.list<Profile>('users', { limit: 2500 }),
      db.get<AccessConfig>('config/access').then((d) => d?.data ?? null),
    ]);
    const byUid = new Map(profiles.map((p) => [p.id, p.data]));
    const rows = accounts.map((a) => row(a, byUid.get(a.uid), access)).sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
    return json({ users: rows, stats: stats(rows), generatedAt: Date.now() });
  }

  if (b.action === 'logs') {
    const logs = await db.list<Record<string, unknown>>('adminLogs', { orderBy: 'at', direction: 'DESCENDING', limit: 100 });
    return json({ logs: logs.map((l) => ({ id: l.id, ...l.data })) });
  }

  const target = await loadTarget(db, b.uid);

  if (b.action === 'detail') {
    const base = `users/${b.uid}`;
    const count = (c: string) => db.count(`${base}/${c}`).catch(() => null);
    const [conversations, documents, memories, projects, knowledgeSources, savedResponses, usage, events, logs] = await Promise.all([
      count('conversations'),
      count('documents'),
      count('memories'),
      count('projects'),
      count('kbSources'),
      count('savedResponses'),
      usageSummary(db, b.uid).catch(() => null),
      db.list<Record<string, unknown>>(`${base}/securityEvents`, { orderBy: 'at', direction: 'DESCENDING', limit: 15 }).catch(() => []),
      db.list<Record<string, unknown>>('adminLogs', { where: [['targetUid', 'EQUAL', b.uid]], limit: 50 }).catch(() => []),
    ]);
    return json({
      user: target.row,
      account: {
        suspendedAt: target.profile?.suspendedAt ?? null,
        deletionScheduledAt: target.profile?.deletionScheduledAt ?? null,
        authDisabled: target.account.disabled,
      },
      counts: { conversations, documents, memories, projects, knowledgeSources, savedResponses },
      usage,
      securityEvents: events.map((e) => ({ id: e.id, ...e.data })),
      adminLogs: logs
        .map((l) => ({ id: l.id, ...l.data }) as Record<string, unknown>)
        .sort((x, y) => String(y.at).localeCompare(String(x.at)))
        .slice(0, 20),
    });
  }

  if (b.action === 'approve') {
    if (!target.account.email) throw new HttpError(400, 'no_email', 'This account has no email address.');
    if (target.row.owner) throw new HttpError(400, 'owner', 'The owner is always approved.');
    const email = target.account.email;
    const allowed = lower(target.access?.allowedEmails).filter((e) => e !== email);
    if (b.approved) allowed.push(email);
    await db.set('config/access', { allowedEmails: allowed, adminEmails: target.access?.adminEmails ?? [] }, true);
    await recordAdminAction(db, { action: b.approved ? 'user_approved' : 'user_unapproved', adminUid: actor.uid, adminEmail: actor.email, targetUid: target.account.uid, targetEmail: email });
    return json({ ok: true });
  }

  assertCanModerate(actor, actorIsOwner, target.row);

  if (b.action === 'suspend') {
    if (target.row.status !== 'active') throw new HttpError(400, 'not_active', 'Only active accounts can be suspended.');
    await suspendAccount(db, actor, target.account, b.reason);
    return json({ ok: true });
  }
  if (b.action === 'reactivate') {
    if (target.row.status !== 'suspended') throw new HttpError(400, 'not_suspended', 'This account is not suspended.');
    await reactivateAccount(db, actor, target.account);
    return json({ ok: true });
  }
  if (b.action === 'delete') {
    assertConfirmed(target.row, b.confirmEmail);
    if (target.row.status === 'deleted') throw new HttpError(400, 'already_deleted', 'This account is already scheduled for deletion.');
    return json({ ok: true, ...(await scheduleDeletion(db, actor, target.account)) });
  }
  if (b.action === 'restore') {
    if (target.row.status !== 'deleted') throw new HttpError(400, 'not_deleted', 'This account is not scheduled for deletion.');
    await restoreAccount(db, actor, target.account);
    return json({ ok: true });
  }
  // purge
  assertConfirmed(target.row, b.confirmEmail);
  return json({ ok: true, ...(await purgeAccount(db, actor, target.account)) });
});
