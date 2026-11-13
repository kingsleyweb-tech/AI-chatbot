import { cleanupPurgedRecords } from '../server/account/retention.js';
import { BILLING_PATH, loadBilling, saveBilling } from '../server/billing/policy.js';
import { providerOverview } from '../server/providers/overview.js';
import { freeModelCandidates } from '../server/providers/registry.js';
import { ProviderError } from '../server/providers/types.js';
import { centralMaintenance } from '../server/central/manage.js';
import {
  changeOwnership,
  IDENTITY_PATH,
  isSuperAdmin,
  loadOwnership,
  OWNERSHIP_CONFIRM,
  ownershipAudit,
} from '../server/chat/ownership.js';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import {
  deleteTemplate,
  deliver,
  loadTemplates,
  MAX_RECIPIENTS,
  recentMessages,
  recipients,
  saveTemplate,
  SMS_MAX,
  smsLeftToday,
  startMessage,
  validateMessage,
  type MessageCandidate,
  type MessageInput,
} from '../server/account/messages.js';
import { accessApprovedNotice } from '../server/account/notices.js';
import { emailDeps } from '../server/email/index.js';
import {
  CONSENT_METHOD_LABEL,
  consentCurrent,
  type ConsentMethod,
  type ConsentRecord,
} from '../server/shared/legal.js';
import {
  approvalConfig,
  clearAccessCache,
  requireAllowedUser,
  type AccessConfig,
  type ApprovalConfig,
} from '../server/access.js';
import {
  deleteRequest,
  listRequests,
  requestStats,
  setAccess,
  type AccessRequest,
} from '../server/account/requests.js';
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
import {
  accountAdmin,
  adminConfigured,
  adminDb,
  SERVER_UID,
  type AuthAccount,
} from '../server/admin.js';
import { maskPhone } from '../server/auth/phone.js';
import { allRestoreRequests, closeRequest, pendingRestoreRequests, remindDue } from '../server/account/restore.js';
import { env } from '../server/env.js';
import type { Firestore } from '../server/firestore.js';
import { listActivity, noteUnauthorizedAccess, pruneActivity, recordAdminAction } from '../server/account/events.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { DEFAULT_FEEDS } from '../server/news/sources.js';
import { loadFeeds, newsAdminView, saveFeedConfig } from '../server/news/stats.js';
import { emailOverview, pruneEmailLog } from '../server/email/log.js';
import { EmailError, getEmailProvider } from '../server/email/provider.js';
import { optionalLimit } from '../server/email/service.js';
import { smsOverview } from '../server/sms/log.js';
import { usageAdmin, usageOpSchema } from '../server/usage/admin.js';
import { loadUsageConfigInfo } from '../server/usage/allowance.js';
import { environmentAdmin, environmentOpSchema } from '../server/environments/admin.js';
import { apiManagement, apiManagementOpSchema } from '../server/apiPlatform/admin.js';
import { pruneApiRecords } from '../server/apiPlatform/log.js';
import { usageEnv, withUsageEnvironment } from '../server/environments/index.js';
import { ENVIRONMENTS } from '../server/shared/environments.js';
import { getOtpGateway, getSmsProvider, vynfyBalances } from '../server/sms/provider.js';

const uid = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const feedId = z.string().regex(/^[a-z0-9_]{2,40}$/);
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('detail'), uid }),
  z.object({ action: z.literal('suspend'), uid, reason: z.string().max(300).optional() }),
  z.object({ action: z.literal('reactivate'), uid }),
  z.object({ action: z.literal('delete'), uid, confirmEmail: z.string().max(320) }),
  z.object({ action: z.literal('restore'), uid }),
  z.object({ action: z.literal('restoreRequests'), history: z.boolean().optional() }),
  z.object({ action: z.literal('activity'), before: z.number().int().positive().optional() }),
  z.object({ action: z.literal('restoreDecline'), uid }),
  z.object({
    action: z.literal('purge'),
    uid,
    confirmEmail: z.string().max(320),
    acknowledge: z.literal(true),
  }),
  z.object({ action: z.literal('approve'), uid, approved: z.boolean() }),
  z.object({ action: z.literal('logs') }),
  z.object({ action: z.literal('providers') }),
  // AI usage allowances: profiles, limits, unlimited access, resets, analytics (server/usage)
  // `environment`: manage that API environment's allowances (default: the active global environment)
  z.object({ action: z.literal('usage'), op: usageOpSchema, environment: z.enum(ENVIRONMENTS).optional() }),
  z.object({ action: z.literal('environments'), op: environmentOpSchema }),
  z.object({ action: z.literal('apiManagement'), op: apiManagementOpSchema }),
  z.object({ action: z.literal('sms') }),
  z.object({ action: z.literal('email') }),
  z.object({ action: z.literal('requests') }),
  z.object({
    action: z.literal('requestDecision'),
    uid,
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(300).optional(),
  }),
  z.object({ action: z.literal('requestDelete'), uid }),
  z.object({ action: z.literal('setAutoApprove'), enabled: z.boolean() }),
  z.object({ action: z.literal('approveAllPending'), confirm: z.literal(true) }),
  z.object({ action: z.literal('news'), days: z.number().int().min(1).max(30).optional() }),
  z.object({
    action: z.literal('newsFeedDisable'),
    id: feedId,
    reason: z.string().max(200).optional(),
  }),
  z.object({ action: z.literal('newsFeedEnable'), id: feedId }),
  z.object({
    action: z.literal('newsFeedAdd'),
    feed: z.object({
      id: feedId,
      name: z.string().min(1).max(80),
      url: z
        .string()
        .url()
        .max(500)
        .regex(/^https:\/\//),
      tier: z.enum(['official', 'wire', 'specialist', 'regional', 'social', 'unknown']),
      topics: z
        .array(
          z.enum([
            'ai',
            'tech',
            'security',
            'space',
            'science',
            'politics',
            'business',
            'health',
            'sports',
            'general',
          ]),
        )
        .min(1)
        .max(6),
      regions: z
        .array(z.string().regex(/^[a-z_]{2,20}$/))
        .min(1)
        .max(6),
    }),
  }),
  z.object({ action: z.literal('newsFeedRemove'), id: feedId }),
  z.object({ action: z.literal('billingGet') }),
  z.object({ action: z.literal('identityGet') }),
  z.object({
    action: z.literal('identitySet'),
    creator: z.string().max(80),
    owner: z.string().max(80),
    aliases: z.array(z.string().max(80)).max(5).optional(),
    reason: z.string().max(500),
    confirmPhrase: z.string().max(40),
    confirmEmail: z.string().max(320),
  }),
  z.object({ action: z.literal('messages') }),
  z.object({
    action: z.literal('messageTemplateSave'),
    template: z.object({
      id: z.string().max(64).optional(),
      name: z.string().max(80),
      subject: z.string().max(150),
      body: z.string().max(5000),
      sms: z.string().max(SMS_MAX),
    }),
  }),
  z.object({ action: z.literal('messageTemplateDelete'), id: z.string().min(1).max(64) }),
  z.object({
    action: z.literal('messageAudience'),
    audience: z.enum(['all', 'approved', 'pending', 'selected', 'me']),
    uids: z.array(z.string().min(1).max(128)).max(MAX_RECIPIENTS).optional(),
    purpose: z.enum(['announcement', 'support']).optional(),
  }),
  z.object({
    action: z.literal('messageSend'),
    audience: z.enum(['all', 'approved', 'pending', 'selected', 'me']),
    uids: z.array(z.string().min(1).max(128)).max(MAX_RECIPIENTS).optional(),
    purpose: z.enum(['announcement', 'support']).optional(),
    email: z.object({ subject: z.string().max(150), body: z.string().max(5000) }).nullable(),
    sms: z.string().max(SMS_MAX + 10).nullable(),
    confirm: z.literal(true),
  }),
  z.object({
    action: z.literal('billingSet'),
    // null: every free model; a list can only narrow (paid ids are refused by saveBilling)
    approvedModels: z.array(z.string().min(3).max(200)).max(200).nullable(),
  }),
]);

interface Profile extends ProfileStatus {
  displayName?: string;
  emailPrefs?: unknown;
  photoURL?: string | null;
  phoneVerified?: boolean;
  lastLoginAt?: string;
  lastActiveAt?: number;
  accessStatus?: string;
  consent?: Partial<ConsentRecord> | null;
}

export interface AdminUserRow {
  uid: string;
  email: string | null;
  name: string;
  photoURL: string | null;
  providers: string[];
  createdAt: number | null;
  lastLoginAt: number | null;
  /** last time the account used the app (written at most every 5 minutes; time only) */
  lastActiveAt: number | null;
  status: 'active' | 'suspended' | 'deleted';
  phoneMasked: string | null;
  phoneVerified: boolean;
  emailVerified: boolean;
  approved: boolean;
  /** administrator approval: pending, approved or rejected */
  accessStatus: 'pending' | 'approved' | 'rejected';
  admin: boolean;
  owner: boolean;
  purgeAfter: number | null;
  /** Terms of Use and Privacy Policy acceptance (current: matches the versions in force) */
  consent: {
    termsVersion: string;
    privacyVersion: string;
    acceptedAt: number | null;
    method: string;
    current: boolean;
  } | null;
}

const NEW_DAYS = 7;
/** "Active now": used the app within this window (last-active is written at most every 5 minutes) */
const ACTIVE_NOW_MS = 10 * 60_000;

/** "Your account has been approved" by email and SMS, after the response. */
function notifyApproved(db: Firestore, uids: string[]) {
  if (!uids.length) return;
  const mail = emailDeps(db);
  const deps = {
    db,
    mail,
    sms: getSmsProvider(),
    accounts: accountAdmin(),
    baseUrl: mail.baseUrl,
    smsDailyCap: env().smsNotifyDailyCap,
  };
  waitUntil(
    (async () => {
      for (const uid of uids) await accessApprovedNotice(deps, uid);
    })(),
  );
}

/** Everyone who could receive an administrator message (verified contacts only). */
async function messageCandidates(db: Firestore): Promise<MessageCandidate[]> {
  const [accounts, profiles, access] = await Promise.all([
    accountAdmin().list(),
    db.list<Profile>('users', { limit: 2500 }),
    db.get<AccessConfig>('config/access').then((d) => d?.data ?? null),
  ]);
  const byUid = new Map(profiles.map((p) => [p.id, p.data]));
  return accounts
    .filter((a) => a.uid !== SERVER_UID)
    .map((a): MessageCandidate => {
      const p = byUid.get(a.uid);
      const r = row(a, p, access);
      return {
        uid: a.uid,
        name: r.name,
        email: a.email,
        emailVerified: a.emailVerified,
        phone: r.phoneVerified && p?.phoneVerified === true ? (p.phoneNumber ?? null) : null,
        status: a.disabled && r.status === 'active' ? 'suspended' : r.status,
        accessStatus: r.accessStatus,
        prefs: p?.emailPrefs,
      };
    });
}

function lower(list?: string[]) {
  return (list ?? []).map((e) => e.toLowerCase());
}

function row(a: AuthAccount, p: Profile | undefined, access: AccessConfig | null): AdminUserRow {
  const owners = lower(env().adminEmails);
  const admins = [...owners, ...lower(access?.adminEmails)];
  const email = a.email ?? null;
  const status =
    p?.accountStatus === 'deleted'
      ? 'deleted'
      : p?.accountStatus === 'suspended' || (a.disabled && p?.accountStatus !== 'active')
        ? 'suspended'
        : 'active';
  return {
    uid: a.uid,
    email,
    name: p?.displayName || a.displayName || email?.split('@')[0] || 'Unnamed',
    photoURL: p?.photoURL ?? a.photoURL,
    providers: a.providers,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt,
    lastActiveAt: typeof p?.lastActiveAt === 'number' ? p.lastActiveAt : null,
    status,
    phoneMasked: p?.phoneNumber ? maskPhone(p.phoneNumber) : null,
    phoneVerified: a.claims.phoneVerified === true && Boolean(p?.phoneNumber),
    emailVerified: a.emailVerified,
    approved: accessOf(email, p, access, admins) === 'approved',
    accessStatus: accessOf(email, p, access, admins),
    admin: Boolean(email && admins.includes(email)),
    owner: Boolean(email && owners.includes(email)),
    purgeAfter: status === 'deleted' ? (p?.purgeAfter ?? null) : null,
    consent: p?.consent?.termsVersion
      ? {
          termsVersion: String(p.consent.termsVersion),
          privacyVersion: String(p.consent.privacyVersion ?? ''),
          acceptedAt: typeof p.consent.acceptedAt === 'number' ? p.consent.acceptedAt : null,
          method: CONSENT_METHOD_LABEL[p.consent.method as ConsentMethod] ?? 'Other',
          current: consentCurrent(p.consent),
        }
      : null,
  };
}

function accessOf(
  email: string | null,
  p: Profile | undefined,
  access: AccessConfig | null,
  admins: string[],
): AdminUserRow['accessStatus'] {
  if (email && admins.includes(email)) return 'approved';
  if (p?.accessStatus === 'rejected') return 'rejected';
  if (p?.accessStatus === 'approved' || (email && lower(access?.allowedEmails).includes(email)))
    return 'approved';
  return 'pending';
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
    /** accounts that used the app in the last 10 minutes, 24 hours and 7 days */
    activeNow: rows.filter((r) => (r.lastActiveAt ?? 0) >= now - ACTIVE_NOW_MS).length,
    activeToday: rows.filter((r) => (r.lastActiveAt ?? 0) >= now - 86_400_000).length,
    activeWeek: rows.filter((r) => (r.lastActiveAt ?? 0) >= now - 7 * 86_400_000).length,
    google: rows.filter((r) => r.providers.includes('google.com')).length,
    password: rows.filter((r) => r.providers.includes('password')).length,
    phoneVerified: rows.filter((r) => r.phoneVerified).length,
    approved: rows.filter((r) => r.accessStatus === 'approved').length,
    pendingApproval: rows.filter((r) => r.accessStatus === 'pending').length,
    rejected: rows.filter((r) => r.accessStatus === 'rejected').length,
    phoneUnverified: rows.filter((r) => !r.phoneVerified).length,
    /** password accounts that cannot use the app until they verify a phone */
    phoneRequiredPending: rows.filter((r) => r.providers.includes('password') && !r.phoneVerified)
      .length,
  };
}

function approvalView(a: ApprovalConfig | null) {
  return {
    autoApprove: a?.autoApprove === true,
    updatedAt: a?.updatedAt ?? null,
    updatedBy: a?.updatedBy ?? null,
  };
}

/** The ten newest profiles with their approval state (for the Access Requests page). */
async function recentProfiles(db: Firestore) {
  const docs = await db.list<{
    displayName?: string;
    email?: string | null;
    provider?: string;
    accessStatus?: string;
    approvedBy?: string;
    accountStatus?: string;
    createdAt?: unknown;
  }>('users', { orderBy: 'createdAt', direction: 'DESCENDING', limit: 10 });
  return docs
    .filter((d) => d.id !== SERVER_UID)
    .map((d) => ({
      uid: d.id,
      name: d.data.displayName ?? null,
      email: d.data.email ?? null,
      provider: d.data.provider ?? null,
      accessStatus: d.data.accessStatus ?? 'pending',
      autoApproved: d.data.approvedBy === 'auto',
      accountStatus: d.data.accountStatus ?? 'active',
      createdAt: toMs(d.data.createdAt),
    }));
}

function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || null;
  return null;
}

async function loadTarget(db: Firestore, targetUid: string) {
  // The server's own sign-in identity is not a user and must never be moderated.
  if (targetUid === SERVER_UID) throw new HttpError(404, 'not_found', 'User not found.');
  const account = await accountAdmin().get(targetUid);
  if (!account) throw new HttpError(404, 'not_found', 'User not found.');
  const access = (await db.get<AccessConfig>('config/access'))?.data ?? null;
  const profile = (await db.get<Profile>(`users/${targetUid}`))?.data;
  return { account, access, profile, row: row(account, profile, access) };
}

/** Administrators cannot act on themselves or the owner; only the owner can act on other admins. */
function assertCanModerate(actor: Actor, actorIsOwner: boolean, target: AdminUserRow) {
  if (target.uid === actor.uid)
    throw new HttpError(400, 'self', 'You cannot do this to your own account.');
  if (target.owner)
    throw new HttpError(403, 'owner', 'The owner account cannot be suspended or deleted.');
  if (target.admin && !actorIsOwner)
    throw new HttpError(
      403,
      'admin_target',
      'Only the owner can suspend or delete another administrator.',
    );
}

function assertConfirmed(target: AdminUserRow, confirmEmail: string) {
  const expected = (target.email ?? target.uid).toLowerCase();
  if (confirmEmail.trim().toLowerCase() !== expected)
    throw new HttpError(400, 'confirm_mismatch', 'The confirmation does not match this account.');
}

async function usageSummary(db: Firestore, targetUid: string) {
  const days = await db.list<{
    date?: string;
    requests?: number;
    promptTokens?: number;
    completionTokens?: number;
    models?: Record<string, { requests?: number; tokens?: number }>;
  }>(`users/${targetUid}/usage`, { orderBy: 'date', direction: 'DESCENDING', limit: 30 });
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
  return {
    days: days.length,
    requests,
    tokens,
    activeDays: days.filter((d) => (d.data.requests ?? 0) > 0).length,
    lastActive: days[0]?.data.date ?? null,
    topModels,
  };
}

/**
 * Daily job (Vercel Cron, see vercel.json): permanently delete accounts whose
 * recovery period has ended, then delete the records kept after a purge once
 * they are 30 days old (server/account/retention.ts). Vercel sends "Authorization: Bearer $CRON_SECRET".
 */
export const GET = handle(async (request) => {
  const secret = process.env.CRON_SECRET ?? '';
  if (new URL(request.url).searchParams.get('job') !== 'purge')
    throw new HttpError(404, 'not_found', 'Not found.');
  if (secret.length < 16 || request.headers.get('authorization') !== `Bearer ${secret}`)
    throw new HttpError(401, 'unauthenticated', 'Not allowed.');
  if (!adminConfigured())
    throw new HttpError(503, 'admin_unconfigured', 'Service account not configured.');
  const db = await adminDb();
  // one reminder 7 days before permanent deletion (accounts deleted by their owner)
  const reminders = env().otpSecret.length >= 32
    ? await remindDue({ db, accounts: accountAdmin(), mail: emailDeps(db), secret: env().otpSecret }).catch((err) => {
        console.error('[restore] reminders failed', err instanceof Error ? err.message : err);
        return 0;
      })
    : 0;
  const activityRemoved = await pruneActivity(db).catch(() => 0);
  const emailLogRemoved = await pruneEmailLog(db).catch(() => 0);
  // API platform: expired request logs, idempotency records and rate/concurrency counters
  const apiRecords = await pruneApiRecords(db).catch((err) => {
    console.error('[api] prune failed', err instanceof Error ? err.message : err);
    return null;
  });
  const result = await purgeDue(db);
  // Records kept after a purge (admin log entries, access request) go 30 days later.
  const retention = await cleanupPurgedRecords(db).catch((err) => {
    console.error('[retention] cleanup failed', err instanceof Error ? err.message : err);
    return { accounts: 0, removed: 0 };
  });
  // Central knowledge upkeep: flags records due for review, re-checks their sources, processes the
  // opt-in discovery queue. It never deletes a record.
  const knowledge = await centralMaintenance(db).catch((err) => {
    console.error('[central] maintenance failed', err instanceof Error ? err.message : err);
    return null;
  });
  return json({
    ok: true,
    purged: result.purged.length,
    reminders,
    activityRemoved,
    emailLogRemoved,
    failed: result.failed.length,
    retentionRemoved: retention.removed,
    knowledge,
    apiRecords,
  });
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
  if (!ctx.admin) {
    await noteUnauthorizedAccess(
      ctx.user.uid,
      'Administrator user management',
      request.headers.get('user-agent'),
    );
    throw new HttpError(403, 'not_admin', 'Administrator access is required.');
  }
  if (!adminConfigured())
    throw new HttpError(
      503,
      'admin_unconfigured',
      'User management needs FIREBASE_SERVICE_ACCOUNT on the server.',
    );
  // (API Management sends integration settings and test-console input, hence the larger limit)
  const parsed = schema.safeParse(await readJson(request, 16_000));
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
    const rows = accounts
      .filter((a) => a.uid !== SERVER_UID)
      .map((a) => row(a, byUid.get(a.uid), access))
      .sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
    return json({ users: rows, stats: stats(rows), generatedAt: Date.now() });
  }

  if (b.action === 'requests') {
    const [rows, approval, recentUsers] = await Promise.all([
      listRequests(db),
      approvalConfig(db, true),
      recentProfiles(db),
    ]);
    return json({
      requests: rows,
      stats: requestStats(rows),
      approval: approvalView(approval),
      recentUsers,
      generatedAt: Date.now(),
    });
  }

  if (b.action === 'setAutoApprove') {
    // Only this server code writes config/approval (the rules give clients no write access).
    const before = await approvalConfig(db, true);
    const previous = before?.autoApprove === true;
    if (previous !== b.enabled) {
      const now = Date.now();
      await db.set(
        'config/approval',
        {
          autoApprove: b.enabled,
          updatedAt: now,
          updatedBy: ctx.user.email ?? ctx.user.uid,
        } satisfies ApprovalConfig,
        true,
      );
      clearAccessCache();
      await recordAdminAction(
        db,
        {
          action: 'auto_approve_changed',
          adminUid: ctx.user.uid,
          adminEmail: ctx.user.email,
          targetUid: 'config/approval',
          targetEmail: null,
          detail: `Automatic approval ${previous ? 'on' : 'off'} → ${b.enabled ? 'on' : 'off'}`,
        },
        now,
      );
    }
    return json({ ok: true, approval: approvalView(await approvalConfig(db, true)) });
  }

  if (b.action === 'approveAllPending') {
    // An explicit administrator choice: automatic approval never touches existing requests.
    const pending = (await listRequests(db)).filter(
      (r) => r.status === 'pending' && r.accountStatus === 'active',
    );
    let approved = 0;
    const approvedUids: string[] = [];
    for (const r of pending.slice(0, 200)) {
      try {
        await setAccess(db, actor, { uid: r.uid, email: r.email }, 'approve');
        approvedUids.push(r.uid);
        approved++;
      } catch (err) {
        console.warn(
          '[admin] bulk approve skipped',
          r.uid,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await recordAdminAction(db, {
      action: 'pending_bulk_approved',
      adminUid: ctx.user.uid,
      adminEmail: ctx.user.email,
      targetUid: 'accessRequests',
      targetEmail: null,
      detail: `${approved} of ${pending.length} pending requests approved`,
    });
    notifyApproved(db, approvedUids);
    return json({ ok: true, approved, total: pending.length });
  }

  if (b.action === 'messages') {
    const [templates, history, smsLeft] = await Promise.all([
      loadTemplates(db),
      recentMessages(db),
      smsLeftToday(db, env().smsMessageDailyCap),
    ]);
    return json({
      templates,
      history,
      limits: {
        smsLeftToday: smsLeft,
        smsDailyCap: env().smsMessageDailyCap,
        maxRecipients: MAX_RECIPIENTS,
        smsMax: SMS_MAX,
        smsConfigured: Boolean(getSmsProvider()),
        emailConfigured: Boolean(getEmailProvider()),
      },
    });
  }

  if (b.action === 'messageTemplateSave') {
    const saved = await saveTemplate(db, b.template, ctx.user.email ?? ctx.user.uid);
    await recordAdminAction(db, {
      action: 'message_template_saved',
      adminUid: ctx.user.uid,
      adminEmail: ctx.user.email,
      targetUid: 'messageTemplates',
      targetEmail: null,
      detail: saved.name,
    });
    return json({ ok: true, template: saved });
  }

  if (b.action === 'messageTemplateDelete') {
    await deleteTemplate(db, b.id);
    await recordAdminAction(db, {
      action: 'message_template_deleted',
      adminUid: ctx.user.uid,
      adminEmail: ctx.user.email,
      targetUid: 'messageTemplates',
      targetEmail: null,
      detail: b.id,
    });
    return json({ ok: true });
  }

  if (b.action === 'messageAudience') {
    const plan = recipients(await messageCandidates(db), b.audience, {
      uids: b.uids,
      selfUid: ctx.user.uid,
      purpose: b.purpose,
    });
    return json({
      total: plan.total,
      email: plan.emails.length,
      sms: plan.texts.length,
      smsLeftToday: await smsLeftToday(db, env().smsMessageDailyCap),
    });
  }

  if (b.action === 'messageSend') {
    const input: MessageInput = { audience: b.audience, uids: b.uids, purpose: b.purpose, email: b.email, sms: b.sms };
    validateMessage(input);
    const plan = recipients(await messageCandidates(db), b.audience, {
      uids: b.uids,
      selfUid: ctx.user.uid,
      purpose: b.purpose,
    });
    const rec = await startMessage(db, input, plan, ctx.user.email ?? ctx.user.uid);
    const what = [b.email ? 'email' : '', b.sms ? 'SMS' : ''].filter(Boolean).join(' and ');
    await recordAdminAction(db, {
      action: 'message_sent',
      adminUid: ctx.user.uid,
      adminEmail: ctx.user.email,
      targetUid: b.purpose === 'support' && b.uids?.length === 1 ? b.uids[0] : 'adminMessages',
      targetEmail: null,
      detail: `${b.purpose === 'support' ? 'support ' : ''}${what} to ${rec.recipients} (${b.audience})`,
    });
    const mail = emailDeps(db);
    waitUntil(
      deliver(
        { db, mail, sms: getSmsProvider(), smsDailyCap: env().smsMessageDailyCap },
        rec,
        input,
        plan,
      ).catch((err) =>
        console.error('[messages] delivery failed', err instanceof Error ? err.message : err),
      ),
    );
    return json({ ok: true, message: rec });
  }

  if (b.action === 'news') {
    return json({ ...(await newsAdminView(db, b.days ?? 7)), generatedAt: Date.now() });
  }

  if (
    b.action === 'newsFeedDisable' ||
    b.action === 'newsFeedEnable' ||
    b.action === 'newsFeedAdd' ||
    b.action === 'newsFeedRemove'
  ) {
    const { config } = await loadFeeds(db);
    const next = {
      disabled: { ...config.disabled },
      enabled: [...config.enabled],
      custom: [...config.custom],
    };
    const isDefault = (id: string) => DEFAULT_FEEDS.some((f) => f.id === id);
    let detail: string;
    if (b.action === 'newsFeedAdd') {
      if (isDefault(b.feed.id) || next.custom.some((c) => c.id === b.feed.id))
        throw new HttpError(409, 'exists', 'A feed with this id already exists.');
      if (next.custom.length >= 100)
        throw new HttpError(400, 'too_many', 'At most 100 added feeds.');
      let domain: string;
      try {
        domain = new URL(b.feed.url).hostname.replace(/^(www|feeds?|rss)\./, '');
      } catch {
        throw new HttpError(400, 'bad_url', 'Invalid feed address.');
      }
      next.custom.push({ ...b.feed, domain });
      detail = `news feed added: ${b.feed.id} (${domain})`;
    } else {
      const known = isDefault(b.id) || next.custom.some((c) => c.id === b.id);
      if (!known) throw new HttpError(404, 'not_found', 'Unknown feed.');
      if (b.action === 'newsFeedDisable') {
        next.disabled[b.id] = b.reason?.trim() || 'Switched off by an administrator.';
        next.enabled = next.enabled.filter((x) => x !== b.id);
        detail = `news feed disabled: ${b.id}`;
      } else if (b.action === 'newsFeedEnable') {
        delete next.disabled[b.id];
        if (isDefault(b.id) && !next.enabled.includes(b.id)) next.enabled.push(b.id);
        detail = `news feed enabled: ${b.id}`;
      } else {
        if (isDefault(b.id))
          throw new HttpError(
            400,
            'built_in',
            'Built-in feeds can be switched off but not removed.',
          );
        next.custom = next.custom.filter((c) => c.id !== b.id);
        delete next.disabled[b.id];
        detail = `news feed removed: ${b.id}`;
      }
    }
    await saveFeedConfig(db, next, ctx.user.uid);
    await recordAdminAction(db, {
      action: 'news_feeds_changed',
      adminUid: ctx.user.uid,
      adminEmail: ctx.user.email,
      targetUid: 'newsFeeds',
      targetEmail: null,
      detail,
    });
    return json({ ok: true });
  }

  // Ownership record (server/chat/ownership.ts). Administrators can view it; only the
  // Super Admin can change it, with a recent sign-in, typed confirmation and a reason.
  if (b.action === 'identityGet' || b.action === 'identitySet') {
    const owners = env().adminEmails;
    const superAdmin = isSuperAdmin(ctx.user, owners);
    if (b.action === 'identitySet') {
      let saved;
      try {
        saved = await changeOwnership(db, ctx.user, owners, b, { userAgent: request.headers.get('user-agent') });
      } catch (err) {
        if (err instanceof HttpError && err.code === 'not_super_admin')
          await noteUnauthorizedAccess(ctx.user.uid, 'Ownership record change', request.headers.get('user-agent'));
        throw err;
      }
      await recordAdminAction(db, {
        action: 'ownership_changed',
        adminUid: ctx.user.uid,
        adminEmail: ctx.user.email,
        targetUid: IDENTITY_PATH,
        targetEmail: null,
        detail: `Creator ${saved.creator}, owner ${saved.owner} (version ${saved.version})`,
      });
    }
    const [record, history] = await Promise.all([
      loadOwnership(db, true),
      superAdmin ? ownershipAudit(db) : Promise.resolve(null),
    ]);
    return json({ record, superAdmin, history, confirmPhrase: OWNERSHIP_CONFIRM });
  }

  if (b.action === 'billingGet' || b.action === 'billingSet') {
    if (b.action === 'billingSet') {
      const before = await loadBilling(true);
      let saved;
      try {
        saved = await saveBilling(b.approvedModels, ctx.user.email ?? ctx.user.uid);
      } catch (err) {
        if (err instanceof ProviderError) throw new HttpError(400, 'not_free', err.message);
        throw err;
      }
      const describe = (l: string[] | null) => (l === null ? 'all free models' : `${l.length} approved free models`);
      await recordAdminAction(db, {
        action: 'billing_policy_changed',
        adminUid: ctx.user.uid,
        adminEmail: ctx.user.email,
        targetUid: BILLING_PATH,
        targetEmail: null,
        detail: `Free Models Only list: ${describe(before.approvedModels)} → ${describe(saved.approvedModels)}`,
      });
    }
    const [settings, candidates] = await Promise.all([loadBilling(true), freeModelCandidates()]);
    return json({ billing: settings, candidates });
  }

  // AI provider accounts: health, usage, cooldowns, switches (labels only; never keys or account ids)
  if (b.action === 'providers') {
    return json(await providerOverview(db), { headers: { 'cache-control': 'no-store' } });
  }

  // API Management (external applications, keys, limits): Super Admin only; key secrets are shown once
  if (b.action === 'apiManagement') {
    if (!isSuperAdmin(ctx.user, env().adminEmails)) {
      await noteUnauthorizedAccess(ctx.user.uid, 'API Management', request.headers.get('user-agent'));
      throw new HttpError(403, 'not_super_admin', 'Only the Super Admin can manage the Atlas AI API.');
    }
    const result = await apiManagement({ db, actor }, b.op);
    return json(result, { headers: { 'cache-control': 'no-store' } });
  }

  // API Environment Manager: Super Admin only (credentials themselves are never returned)
  if (b.action === 'environments') {
    if (!isSuperAdmin(ctx.user, env().adminEmails)) {
      await noteUnauthorizedAccess(ctx.user.uid, 'API Environment Manager', request.headers.get('user-agent'));
      throw new HttpError(403, 'not_super_admin', 'Only the Super Admin can manage API environments.');
    }
    const result = await environmentAdmin({ db, actor }, b.op);
    return json(result, { headers: { 'cache-control': 'no-store' } });
  }

  if (b.action === 'usage') {
    const access = await db.get<AccessConfig>('config/access').then((d) => d?.data ?? null);
    const admins = new Set([...lower(env().adminEmails), ...lower(access?.adminEmails)]);
    let accounts: { uid: string; email: string | null; name: string }[] | null = null;
    const usageEnvironment = b.environment ?? usageEnv();
    const result = await withUsageEnvironment(usageEnvironment, () => usageAdmin(
      {
        db,
        actor,
        accounts: async () =>
          (accounts ??= (await accountAdmin().list())
            .filter((a) => a.uid !== SERVER_UID)
            .map((a) => ({ uid: a.uid, email: a.email ?? null, name: a.displayName ?? a.email ?? a.uid }))),
        isAdminEmail: (email) => Boolean(email && admins.has(email.toLowerCase())),
      },
      b.op,
    ));
    const inherited = usageEnvironment !== 'main' && b.op.op === 'get' ? (await withUsageEnvironment(usageEnvironment, () => loadUsageConfigInfo(db, true))).inherited : false;
    return json(
      result && typeof result === 'object' ? { ...result, environment: usageEnvironment, inherited } : result,
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  if (b.action === 'logs') {
    const logs = await db.list<Record<string, unknown>>('adminLogs', {
      orderBy: 'at',
      direction: 'DESCENDING',
      limit: 100,
    });
    return json({ logs: logs.map((l) => ({ id: l.id, ...l.data })) });
  }

  if (b.action === 'sms') {
    const [overview, balances] = await Promise.all([
      smsOverview(db, getSmsProvider(), Date.now(), getOtpGateway()),
      vynfyBalances(),
    ]);
    const uids = [
      ...new Set(overview.recent.map((r) => r.uid).filter((u): u is string => Boolean(u))),
    ];
    const accounts = await Promise.all(
      uids.map((u) =>
        accountAdmin()
          .get(u)
          .catch(() => null),
      ),
    );
    const who = new Map(
      uids.map((u, i) => [
        u,
        accounts[i]
          ? { email: accounts[i]!.email ?? null, name: accounts[i]!.displayName ?? null }
          : null,
      ]),
    );
    const e = env();
    return json({
      totals: overview.totals,
      balances,
      config: {
        sender: e.vynfySender || null,
        otpService: Boolean(getOtpGateway()),
        otpLength: e.otpLength,
        otpExpiryMin: e.otpExpiryMin,
        smsFallback: e.otpSmsFallback,
        webhook: Boolean(e.vynfyWebhookSecret),
        sandbox: e.vynfySandbox,
      },
      recent: overview.recent.map((r) => ({
        id: r.id,
        at: r.at,
        updatedAt: r.updatedAt,
        purpose: r.purpose,
        route: r.route,
        // network prefix + last four digits only
        phone: r.phone
          ? `${r.phone.slice(0, 4)} ${r.phone.slice(4, 6)} ••• ${r.phone.slice(-4)}`
          : null,
        ref: r.ref,
        accepted: r.accepted,
        delivery: r.delivery,
        providerStatus: r.providerStatus ?? null,
        error: r.error ?? null,
        outcome: r.outcome,
        uid: r.uid,
        user: r.uid ? (who.get(r.uid) ?? null) : null,
      })),
      generatedAt: Date.now(),
    });
  }

  if (b.action === 'email') {
    // Only what the provider and our log actually report: no message contents, codes or keys.
    const e = env();
    const provider = getEmailProvider();
    let connection: {
      state: 'unconfigured' | 'connected' | 'error';
      code: string | null;
      message: string | null;
      plan: string | null;
      credits: number | null;
    } = {
      state: 'unconfigured',
      code: null,
      message: null,
      plan: null,
      credits: null,
    };
    if (provider?.account) {
      try {
        const a = await provider.account();
        connection = {
          state: 'connected',
          code: null,
          message: null,
          plan: a?.plan ?? null,
          credits: a?.credits ?? null,
        };
      } catch (err) {
        connection = {
          state: 'error',
          code: err instanceof EmailError ? err.code : 'failed',
          message: err instanceof Error ? err.message : 'Connection check failed',
          plan: null,
          credits: null,
        };
      }
    }
    const overview = await emailOverview(db, provider);
    const day = new Date().toISOString().slice(0, 10);
    const today = (await db.get<{ sent?: number }>(`emailStats/${day}`))?.data.sent ?? 0;
    return json({
      config: {
        provider: e.emailProvider,
        apiKeySet: Boolean(e.brevoKey),
        sender: e.emailFrom || null,
        senderName: e.emailFromName,
        dailyCap: e.emailDailyCap,
        optionalLimit: optionalLimit(e.emailDailyCap),
        sentToday: today,
        publicUrl: e.publicUrl,
        // a free-mail sender is not authenticated for Brevo (SPF/DKIM/DMARC)
        senderDomainWarning: /@(gmail|yahoo|outlook|hotmail|icloud|live|aol)\./i.test(e.emailFrom),
      },
      connection,
      totals: overview.totals,
      byType: overview.byType,
      recent: overview.recent.map((r) => ({
        id: r.id,
        at: r.at,
        type: r.type,
        to: r.to,
        from: r.from ?? null,
        accepted: r.accepted,
        status: r.status,
        providerStatus: r.providerStatus ?? null,
        error: r.error ?? null,
        errorCode: r.errorCode ?? null,
        attempts: r.attempts ?? null,
        opened: Boolean(r.opened),
      })),
      generatedAt: Date.now(),
    });
  }

  if (b.action === 'restoreRequests') {
    const requests = b.history ? await allRestoreRequests(db) : await pendingRestoreRequests(db);
    return json({
      requests: requests.map((r) => ({
        uid: r.uid,
        email: r.email,
        reason: r.reason,
        status: r.status,
        requestedAt: r.confirmedAt ?? r.createdAt,
        decidedAt: r.decidedAt ?? null,
        purgeAfter: r.purgeAfter,
        deletedBy: r.deletedBy,
      })),
    });
  }
  if (b.action === 'activity') {
    // What happened on accounts (sign-ins, sign-ups, security changes, deletions, restores).
    // Never conversation content; names and addresses come from the profiles.
    const rows = await listActivity(db, b.before, 100);
    const uids = [...new Set(rows.map((r) => r.data.uid))];
    const profiles = await Promise.all(
      uids.map((u) => db.get<{ email?: string | null; displayName?: string | null; name?: string | null }>(`users/${u}`).catch(() => null)),
    );
    const who = new Map(uids.map((u, i) => [u, { email: profiles[i]?.data.email ?? null, name: profiles[i]?.data.displayName ?? profiles[i]?.data.name ?? null }]));
    return json({
      entries: rows.map((r) => ({ id: r.id, ...r.data, ...who.get(r.data.uid) })),
      more: rows.length === 100,
    });
  }
  if (b.action === 'restoreDecline') {
    const target = await accountAdmin().get(b.uid);
    if (!(await closeRequest(db, b.uid, 'declined', Date.now(), actor.uid, emailDeps(db))))
      throw new HttpError(400, 'no_request', 'There is no restore request waiting for this account.');
    await recordAdminAction(db, { action: 'restore_request_declined', adminUid: actor.uid, adminEmail: actor.email, targetUid: b.uid, targetEmail: target?.email ?? null });
    return json({ ok: true });
  }

  if (b.action === 'requestDelete') {
    await deleteRequest(db, actor, b.uid);
    return json({ ok: true });
  }

  const target = await loadTarget(db, b.uid);

  if (b.action === 'requestDecision') {
    if (target.row.owner) throw new HttpError(400, 'owner', 'The owner is always approved.');
    if (b.decision === 'reject' && target.row.admin)
      throw new HttpError(
        400,
        'admin_target',
        'Remove administrator rights before rejecting this account.',
      );
    await setAccess(db, actor, { uid: b.uid, email: target.account.email }, b.decision, b.note);
    if (b.decision === 'approve' && target.row.accessStatus !== 'approved')
      notifyApproved(db, [b.uid]);
    return json({ ok: true });
  }

  if (b.action === 'detail') {
    const base = `users/${b.uid}`;
    const count = (c: string) => db.count(`${base}/${c}`).catch(() => null);
    const [
      conversations,
      documents,
      memories,
      projects,
      knowledgeSources,
      savedResponses,
      usage,
      events,
      logs,
    ] = await Promise.all([
      count('conversations'),
      count('documents'),
      count('memories'),
      count('projects'),
      count('kbSources'),
      count('savedResponses'),
      usageSummary(db, b.uid).catch(() => null),
      db
        .list<Record<string, unknown>>(`${base}/securityEvents`, {
          orderBy: 'at',
          direction: 'DESCENDING',
          limit: 15,
        })
        .catch(() => []),
      db
        .list<Record<string, unknown>>('adminLogs', {
          where: [['targetUid', 'EQUAL', b.uid]],
          limit: 50,
        })
        .catch(() => []),
    ]);
    const accessRequest =
      (await db.get<AccessRequest>(`accessRequests/${b.uid}`).catch(() => null))?.data ?? null;
    return json({
      user: target.row,
      accessRequest,
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
    if (target.row.owner) throw new HttpError(400, 'owner', 'The owner is always approved.');
    if (!b.approved && target.row.admin)
      throw new HttpError(
        400,
        'admin_target',
        'Remove administrator rights before revoking access.',
      );
    await setAccess(
      db,
      actor,
      { uid: b.uid, email: target.account.email },
      b.approved ? 'approve' : 'reject',
    );
    if (b.approved && target.row.accessStatus !== 'approved') notifyApproved(db, [b.uid]);
    return json({ ok: true });
  }

  assertCanModerate(actor, actorIsOwner, target.row);

  if (b.action === 'suspend') {
    if (target.row.status !== 'active')
      throw new HttpError(400, 'not_active', 'Only active accounts can be suspended.');
    await suspendAccount(db, actor, target.account, b.reason);
    return json({ ok: true });
  }
  if (b.action === 'reactivate') {
    if (target.row.status !== 'suspended')
      throw new HttpError(400, 'not_suspended', 'This account is not suspended.');
    await reactivateAccount(db, actor, target.account);
    return json({ ok: true });
  }
  if (b.action === 'delete') {
    assertConfirmed(target.row, b.confirmEmail);
    if (target.row.status === 'deleted')
      throw new HttpError(
        400,
        'already_deleted',
        'This account is already scheduled for deletion.',
      );
    return json({ ok: true, ...(await scheduleDeletion(db, actor, target.account)) });
  }
  if (b.action === 'restore') {
    if (target.row.status !== 'deleted')
      throw new HttpError(400, 'not_deleted', 'This account is not scheduled for deletion.');
    await restoreAccount(db, actor, target.account);
    // a waiting restore request is answered with an email
    await closeRequest(db, b.uid, 'restored', Date.now(), actor.uid, emailDeps(db)).catch(() => false);
    return json({ ok: true });
  }
  // purge
  assertConfirmed(target.row, b.confirmEmail);
  return json({ ok: true, ...(await purgeAccount(db, actor, target.account)) });
});
