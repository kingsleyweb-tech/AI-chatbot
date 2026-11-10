/**
 * Account security events and administrator activity logs.
 *
 * Both are written only by the server with privileged credentials:
 *   users/{uid}/securityEvents/{id}   readable by the account owner, never writable by clients
 *   adminLogs/{id}                    readable by administrators, never writable by clients
 * Entries carry codes and coarse metadata only: never passwords, codes, tokens
 * or full phone numbers.
 */
import { randomBytes } from 'node:crypto';
import type { Firestore } from '../firestore.js';

export const SECURITY_EVENTS = [
  'login',
  'login_failed',
  'logout',
  'logout_inactivity',
  'password_reset',
  'password_changed',
  'phone_verified',
  'phone_changed',
  'phone_removed',
  'provider_linked',
  'sessions_revoked',
  'account_suspended',
  'account_reactivated',
  'account_deletion_scheduled',
  'account_restored',
  'data_exported',
  'access_requested',
  'access_approved',
  'access_rejected',
  'unauthorized_access',
  'terms_accepted',
  'email_verified',
  'device_removed',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENTS)[number];

export const ADMIN_ACTIONS = [
  'user_suspended',
  'user_reactivated',
  'user_deletion_scheduled',
  'user_restored',
  'user_purged',
  'retention_cleanup',
  'user_approved',
  'user_unapproved',
  'request_approved',
  'request_rejected',
  'request_deleted',
  'user_auto_approved',
  'auto_approve_changed',
  'billing_policy_changed',
  'message_sent',
  'message_template_saved',
  'message_template_deleted',
  'pending_bulk_approved',
  'support_replied',
  'support_status_changed',
  'support_priority_changed',
  'support_assigned',
  'support_note_added',
  'support_deleted',
  'help_article_saved',
  'help_article_deleted',
  'news_feeds_changed',
  'ownership_changed',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** Short, sortable id: time first so documents list in order. */
export function eventId(now = Date.now()) {
  return `${String(now).padStart(14, '0')}_${randomBytes(4).toString('hex')}`;
}

/** Coarse device description from a user agent ("Safari on iPhone"); never the full string. */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown OS';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /FxiOS|Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  return `${browser} on ${os}`;
}

export async function recordSecurityEvent(
  db: Firestore,
  uid: string,
  type: SecurityEventType,
  meta: {
    provider?: string;
    device?: string;
    by?: 'user' | 'admin' | 'system';
    detail?: string;
  } = {},
  now = Date.now(),
): Promise<void> {
  await db
    .set(`users/${uid}/securityEvents/${eventId(now)}`, {
      type,
      at: new Date(now),
      provider: meta.provider ?? null,
      device: meta.device ?? null,
      by: meta.by ?? 'user',
      detail: meta.detail?.slice(0, 200) ?? null,
    })
    .catch((err) =>
      console.warn('[security] event not recorded', type, err instanceof Error ? err.message : err),
    );
}

export async function recordAdminAction(
  db: Firestore,
  entry: {
    action: AdminAction;
    adminUid: string;
    adminEmail: string | null;
    targetUid: string;
    targetEmail: string | null;
    detail?: string;
  },
  now = Date.now(),
): Promise<void> {
  await db.set(`adminLogs/${eventId(now)}`, {
    ...entry,
    detail: entry.detail?.slice(0, 300) ?? null,
    at: new Date(now),
  });
}

/**
 * A signed-in, non-administrator account called an administrator-only API.
 * Logged (best effort, never blocking the 403) so repeated probing is visible;
 * the account is not suspended automatically.
 */
export async function noteUnauthorizedAccess(
  uid: string,
  area: string,
  userAgent: string | null,
): Promise<void> {
  console.warn('[security] unauthorized access attempt', { uid, area });
  try {
    const { adminConfigured, adminDb } = await import('../admin.js');
    if (!adminConfigured()) return;
    await recordSecurityEvent(await adminDb(), uid, 'unauthorized_access', {
      device: deviceLabel(userAgent),
      by: 'system',
      detail: area,
    });
  } catch (err) {
    console.warn(
      '[security] unauthorized access log skipped',
      err instanceof Error ? err.message : err,
    );
  }
}
