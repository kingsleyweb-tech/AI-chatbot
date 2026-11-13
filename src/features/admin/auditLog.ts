/** Shared helpers for the administrator audit log (adminLogs, written only by the server). */

export interface LogEntry {
  id: string;
  action: string;
  adminEmail?: string | null;
  targetEmail?: string | null;
  detail?: string | null;
  /** previous and new values, for usage and access changes */
  changes?: { before: unknown; after: unknown } | null;
  at?: unknown;
}

/** Firestore REST values arrive as ISO strings, numbers or {seconds}. */
export function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && 'seconds' in v) return new Date(Number((v as { seconds: number }).seconds) * 1000);
  return null;
}

export const fmt = (v: unknown, withTime = false) => {
  const d = toDate(v);
  return d ? d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) : 'Never';
};

export const ACTION_LABELS: Record<string, string> = {
  user_suspended: 'Suspended',
  user_reactivated: 'Reactivated',
  user_deletion_scheduled: 'Scheduled deletion',
  user_restored: 'Restored',
  user_purged: 'Permanently deleted',
  retention_cleanup: 'Old records deleted (30-day retention)',
  user_approved: 'Approved',
  user_unapproved: 'Access removed',
  user_auto_approved: 'Approved automatically',
  auto_approve_changed: 'Changed automatic approval',
  pending_bulk_approved: 'Approved all pending requests',
  billing_policy_changed: 'Changed the billing policy',
  request_approved: 'Access request approved',
  request_rejected: 'Access request rejected',
  request_deleted: 'Access request deleted',
  ownership_changed: 'Changed the ownership record',
  maintenance_on: 'Turned maintenance mode on',
  maintenance_off: 'Turned maintenance mode off',
  maintenance_updated: 'Changed the maintenance notice',
  support_replied: 'Replied to a support report',
  support_status_changed: 'Changed a support report status',
  support_priority_changed: 'Changed a support report priority',
  support_assigned: 'Assigned a support report',
  support_note_added: 'Added an internal note',
  support_deleted: 'Deleted a support report',
  help_article_saved: 'Saved a help article',
  help_article_deleted: 'Removed a help article',
  news_feeds_changed: 'Changed the news feeds',
  message_sent: 'Sent a message to users',
  message_template_saved: 'Saved a message template',
  message_template_deleted: 'Deleted a message template',
  usage_config_changed: 'Changed AI usage settings',
  usage_profile_saved: 'Saved a usage profile',
  usage_profile_deleted: 'Deleted a usage profile',
  usage_profile_assigned: 'Changed an account’s usage limits',
  usage_unlimited_granted: 'Granted unlimited AI access',
  usage_unlimited_revoked: 'Removed unlimited AI access',
  usage_unlimited_expired: 'Unlimited AI access expired',
  usage_reset: 'Reset an AI allowance',
  environment_switched: 'Switched the API environment',
  environment_switch_refused: 'API environment switch refused',
  environment_disabled: 'Switched off an API environment',
  environment_enabled: 'Switched an API environment back on',
  environment_ceiling_changed: 'Changed the Temporary environment ceiling',
  restore_request_declined: 'Declined a restore request',
  api_integration_created: 'Created an API integration',
  api_integration_updated: 'Changed an API integration',
  api_integration_status_changed: 'Changed an API integration’s status',
  api_integration_deleted: 'Deleted an API integration',
  api_key_created: 'Created an API key',
  api_key_rotated: 'Rotated an API key',
  api_key_revoked: 'Revoked an API key',
  api_key_status_changed: 'Changed an API key’s status',
  api_key_updated: 'Changed an API key',
};

/** Groups for the audit log filter */
export const ACTION_GROUPS: { id: string; label: string; match: (a: string) => boolean }[] = [
  { id: 'all', label: 'All actions', match: () => true },
  { id: 'accounts', label: 'Accounts', match: (a) => a.startsWith('user_') || a === 'retention_cleanup' },
  { id: 'access', label: 'Access requests', match: (a) => a.startsWith('request_') || a === 'auto_approve_changed' || a === 'pending_bulk_approved' },
  { id: 'usage', label: 'AI usage and limits', match: (a) => a.startsWith('usage_') },
  { id: 'support', label: 'Support and help', match: (a) => a.startsWith('support_') || a.startsWith('help_') },
  { id: 'messages', label: 'Messages', match: (a) => a.startsWith('message_') },
  { id: 'environments', label: 'API environments', match: (a) => a.startsWith('environment_') },
  { id: 'api', label: 'API management', match: (a) => a.startsWith('api_') },
  { id: 'settings', label: 'Settings and ownership', match: (a) => ['billing_policy_changed', 'news_feeds_changed', 'ownership_changed'].includes(a) || a.startsWith('maintenance_') },
];
