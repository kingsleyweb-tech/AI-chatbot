import { Activity, Clock, LifeBuoy, RefreshCw, Search, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Input, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import { useNewReports, usePendingRequests } from '../shell/Sidebar';
import { RestoreRequests } from './RestoreRequests';
import { ActiveSummary } from './activeStatus';

/** Mirrors the activity response of api/admin.ts. */
interface Entry {
  id: string;
  uid: string;
  type: string;
  atMs: number;
  device: string | null;
  provider: string | null;
  by: 'user' | 'admin' | 'system';
  detail: string | null;
  email: string | null;
  name: string | null;
}

interface HistoryRow {
  uid: string;
  email: string;
  reason: string | null;
  status: 'unconfirmed' | 'pending' | 'restored' | 'declined';
  requestedAt: number;
  decidedAt: number | null;
  purgeAfter: number | null;
  deletedBy: 'admin' | 'user' | null;
}

interface UserRow {
  uid: string;
  email: string | null;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  purgeAfter: number | null;
}

/** What each account event means, and the group it is filtered under. */
const EVENTS: Record<string, { label: string; group: Group }> = {
  login: { label: 'Signed in', group: 'signin' },
  logout: { label: 'Signed out', group: 'signin' },
  logout_inactivity: { label: 'Signed out after inactivity', group: 'signin' },
  failed_login: { label: 'Failed sign-in', group: 'signin' },
  sessions_revoked: { label: 'Signed out of all devices', group: 'security' },
  password_reset: { label: 'Reset their password', group: 'security' },
  password_changed: { label: 'Changed their password', group: 'security' },
  phone_verified: { label: 'Verified a phone number', group: 'security' },
  phone_changed: { label: 'Changed their phone number', group: 'security' },
  phone_removed: { label: 'Removed their phone number', group: 'security' },
  email_verified: { label: 'Verified their email', group: 'security' },
  provider_linked: { label: 'Added a sign-in method', group: 'security' },
  device_removed: { label: 'Removed a device', group: 'security' },
  data_exported: { label: 'Exported their data', group: 'security' },
  access_requested: { label: 'Asked for access (new sign-up)', group: 'access' },
  access_approved: { label: 'Was approved', group: 'access' },
  access_rejected: { label: 'Was declined', group: 'access' },
  terms_accepted: { label: 'Accepted the Terms and Privacy Policy', group: 'access' },
  unauthorized_access: { label: 'Tried to open an admin-only area', group: 'security' },
  account_suspended: { label: 'Account suspended', group: 'lifecycle' },
  account_reactivated: { label: 'Account reactivated', group: 'lifecycle' },
  account_deletion_scheduled: { label: 'Account deleted (30-day recovery)', group: 'lifecycle' },
  account_restored: { label: 'Account restored', group: 'lifecycle' },
  restore_requested: { label: 'Asked to restore their account', group: 'lifecycle' },
  restore_confirmed: { label: 'Confirmed their restore request', group: 'lifecycle' },
};
type Group = 'signin' | 'security' | 'access' | 'lifecycle';
const GROUPS: { id: 'all' | Group; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'access', label: 'Sign-ups and access' },
  { id: 'signin', label: 'Sign-ins' },
  { id: 'security', label: 'Security changes' },
  { id: 'lifecycle', label: 'Deletions and restores' },
];
const TONE: Record<Group, string> = {
  signin: 'bg-surface-2 text-muted',
  security: 'bg-warn-soft text-warn',
  access: 'bg-accent/10 text-accent',
  lifecycle: 'bg-danger-soft text-danger',
};

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const daysLeft = (ms: number | null) => (ms ? Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000)) : null);

function Tile({ icon, label, value, to, hint }: { icon: ReactNode; label: string; value: number | null; to?: string; hint?: string }) {
  const body = (
    <div className="flex h-full items-start gap-3 rounded-2xl border border-border p-4 transition-colors hover:bg-surface-2">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-accent">{icon}</div>
      <div className="min-w-0">
        <div className="text-2xl font-semibold tabular-nums">{value ?? '–'}</div>
        <div className="text-sm text-fg/90">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

/**
 * Admin › Activity & Requests: everything that is happening on accounts in one
 * place — requests waiting for a decision, accounts waiting to be permanently
 * deleted, and a feed of account events (sign-ups, sign-ins, security changes,
 * deletions, restores). Conversation content is never shown here or sent by the server.
 */
export default function ActivityPage() {
  const { admin } = useAuth();
  const toast = useToast();
  const pendingAccess = usePendingRequests(admin);
  const newReports = useNewReports(admin);
  const [tab, setTab] = useState<'attention' | 'feed' | 'history'>('attention');
  const [restoreCount, setRestoreCount] = useState<number | null>(null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [active, setActive] = useState<{ activeNow: number; activeToday: number; activeWeek: number } | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [group, setGroup] = useState<'all' | Group>('all');
  const [q, setQ] = useState('');
  const [restoring, setRestoring] = useState<UserRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadUsers = useCallback(async () => {
    try {
      const r = await api<{ users: UserRow[]; stats: { activeNow: number; activeToday: number; activeWeek: number } }>('admin', {
        json: { action: 'list' },
      });
      setUsers(r.users);
      setActive(r.stats);
    } catch {
      setUsers([]);
    }
  }, []);
  const loadCounts = useCallback(async () => {
    try {
      const r = await api<{ requests: unknown[] }>('admin', { json: { action: 'restoreRequests' } });
      setRestoreCount(r.requests.length);
    } catch {
      setRestoreCount(null);
    }
  }, []);
  const loadFeed = useCallback(
    async (before?: number) => {
      setLoadingFeed(true);
      try {
        const r = await api<{ entries: Entry[]; more: boolean }>('admin', { json: { action: 'activity', ...(before ? { before } : {}) } });
        setEntries((cur) => (before && cur ? [...cur, ...r.entries] : r.entries));
        setMore(r.more);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Activity could not be loaded.', 'error');
        setEntries((cur) => cur ?? []);
      } finally {
        setLoadingFeed(false);
      }
    },
    [toast],
  );
  const loadHistory = useCallback(async () => {
    try {
      const r = await api<{ requests: HistoryRow[] }>('admin', { json: { action: 'restoreRequests', history: true } });
      setHistory(r.requests);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
    void loadCounts();
  }, [loadUsers, loadCounts, refreshKey]);
  useEffect(() => {
    if (tab === 'feed') void loadFeed();
    if (tab === 'history') void loadHistory();
  }, [tab, loadFeed, loadHistory, refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);
  const scheduled = useMemo(
    () => (users ?? []).filter((u) => u.status === 'deleted').sort((a, b) => (a.purgeAfter ?? 0) - (b.purgeAfter ?? 0)),
    [users],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) =>
        (group === 'all' || EVENTS[e.type]?.group === group) &&
        (!needle || (e.email ?? '').toLowerCase().includes(needle) || (e.name ?? '').toLowerCase().includes(needle)),
    );
  }, [entries, group, q]);

  const restore = async () => {
    if (!restoring) return;
    try {
      await api('admin', { json: { action: 'restore', uid: restoring.uid } });
      toast(`${restoring.email ?? 'The account'} was restored.`, 'success');
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The account could not be restored.', 'error');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Page
      title="Activity & Requests"
      wide
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-5xl">
        <p className="mb-5 text-sm text-muted">
          Everything happening on accounts: requests waiting for you, accounts about to be deleted for good, and a feed of what users do.
          Conversations are private and never appear here.
        </p>

        {active && <ActiveSummary now={active.activeNow} today={active.activeToday} week={active.activeWeek} className="mb-4" />}
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile icon={<LifeBuoy className="size-5" />} label="Restore requests waiting" value={restoreCount} />
          <Tile icon={<UserPlus className="size-5" />} label="Access requests waiting" value={pendingAccess} to="/admin/requests" />
          <Tile icon={<Activity className="size-5" />} label="New support reports" value={newReports} to="/admin/support" />
          <Tile
            icon={<Trash2 className="size-5" />}
            label="Scheduled for deletion"
            value={users ? scheduled.length : null}
            hint={scheduled[0]?.purgeAfter ? `next on ${new Date(scheduled[0].purgeAfter).toLocaleDateString()}` : undefined}
          />
        </div>

        <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
          {(
            [
              ['attention', 'Needs attention'],
              ['feed', 'Activity feed'],
              ['history', 'Restore history'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors',
                tab === id ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'attention' && (
          <>
            <RestoreRequests key={refreshKey} onChanged={refresh} onOpen={() => undefined} />
            {restoreCount === 0 && (
              <p className="mb-6 rounded-2xl border border-border px-4 py-3 text-sm text-muted">No restore requests are waiting.</p>
            )}
            <section className="rounded-2xl border border-border">
              <h2 className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold">
                <Clock className="size-4 text-muted" /> Accounts waiting for permanent deletion
              </h2>
              {users === null ? (
                <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted">
                  <Spinner className="size-4" /> Loading
                </div>
              ) : scheduled.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">No accounts are scheduled for deletion.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {scheduled.map((u) => {
                    const left = daysLeft(u.purgeAfter);
                    return (
                      <li key={u.uid} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 text-sm">
                          <div className="truncate font-medium">{u.name || u.email}</div>
                          <div className="truncate text-xs text-muted">
                            {u.email}
                            {left !== null && ` · deleted for good in ${left} ${left === 1 ? 'day' : 'days'}`}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setRestoring(u)}>
                          Restore
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}

        {tab === 'feed' && (
          <>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                <Input className="pl-9" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <Select
                value={group}
                onChange={(v) => setGroup(v as 'all' | Group)}
                className="sm:w-56"
                options={GROUPS.map((g) => ({ value: g.id, label: g.label }))}
              />
            </div>
            {entries === null ? (
              <div className="flex items-center gap-2 py-10 text-sm text-muted">
                <Spinner className="size-4" /> Loading activity
              </div>
            ) : shown.length === 0 ? (
              <p className="rounded-2xl border border-border px-4 py-6 text-sm text-muted">
                {entries.length ? 'Nothing matches this filter.' : 'No activity recorded yet. New events appear here as they happen (kept for 90 days).'}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-2xl border border-border">
                {shown.map((e) => {
                  const ev = EVENTS[e.type];
                  return (
                    <li key={e.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-start sm:gap-4">
                      <div className="w-40 shrink-0 text-xs text-muted tabular-nums">{when(e.atMs)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{e.name || e.email || 'Deleted account'}</span>
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TONE[ev?.group ?? 'signin'])}>
                            {ev?.label ?? e.type.replace(/_/g, ' ')}
                          </span>
                          {e.by !== 'user' && <Badge tone="neutral">by {e.by === 'admin' ? 'an administrator' : 'the system'}</Badge>}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {[e.name ? e.email : null, e.device, e.detail].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {more && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" loading={loadingFeed} onClick={() => void loadFeed(entries?.at(-1)?.atMs)}>
                  Load older activity
                </Button>
              </div>
            )}
          </>
        )}

        {tab === 'history' &&
          (history === null ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted">
              <Spinner className="size-4" /> Loading
            </div>
          ) : history.length === 0 ? (
            <p className="rounded-2xl border border-border px-4 py-6 text-sm text-muted">No restore requests yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {history.map((r) => (
                <li key={`${r.uid}-${r.requestedAt}`} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{r.email}</span>
                    <Badge tone={r.status === 'restored' ? 'accent' : r.status === 'declined' ? 'danger' : r.status === 'pending' ? 'warn' : 'neutral'}>
                      {r.status === 'unconfirmed' ? 'Email not confirmed' : r.status === 'pending' ? 'Waiting for you' : r.status === 'restored' ? 'Restored' : 'Declined'}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    Asked {when(r.requestedAt)}
                    {r.decidedAt ? ` · decided ${when(r.decidedAt)}` : ''} · {r.deletedBy === 'user' ? 'deleted by themselves' : 'deleted by an administrator'}
                  </div>
                  {r.reason && <p className="mt-1 text-[13px] text-fg/90">“{r.reason}”</p>}
                </li>
              ))}
            </ul>
          ))}
      </div>

      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        onConfirm={() => void restore()}
        title="Restore this account?"
        message={`${restoring?.email ?? 'This account'} can sign in again straight away, with all their data.`}
        confirmLabel="Restore"
        danger={false}
      />
    </Page>
  );
}
