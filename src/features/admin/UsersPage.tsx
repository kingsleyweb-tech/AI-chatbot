import { RefreshCw, Search, ShieldCheck, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, Label, Select, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn, formatTokens, modelShortName } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

/** Mirrors AdminUserRow in api/admin.ts (no secrets, masked phone only). */
interface UserRow {
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
  accessStatus: 'pending' | 'approved' | 'rejected';
  admin: boolean;
  owner: boolean;
  purgeAfter: number | null;
}

interface Stats {
  total: number;
  active: number;
  suspended: number;
  pendingDeletion: number;
  newUsers: number;
  newDays: number;
  google: number;
  password: number;
  phoneVerified: number;
  phoneUnverified: number;
  phoneRequiredPending: number;
  approved: number;
  pendingApproval: number;
  rejected: number;
}

interface LogEntry {
  id: string;
  action: string;
  adminEmail?: string | null;
  targetEmail?: string | null;
  detail?: string | null;
  at?: unknown;
}

interface Detail {
  user: UserRow;
  account: { suspendedAt: unknown; deletionScheduledAt: unknown; authDisabled: boolean };
  counts: Record<string, number | null>;
  usage: { days: number; requests: number; tokens: number; activeDays: number; lastActive: string | null; topModels: { model: string; requests: number; tokens: number }[] } | null;
  securityEvents: { id: string; type: string; at?: unknown; device?: string | null; by?: string | null }[];
  adminLogs: LogEntry[];
}

type Action = { kind: 'suspend' | 'reactivate' | 'delete' | 'restore' | 'purge'; user: UserRow };

/** Firestore REST values arrive as ISO strings, numbers or {seconds}. */
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && 'seconds' in v) return new Date(Number((v as { seconds: number }).seconds) * 1000);
  return null;
}
const fmt = (v: unknown, withTime = false) => {
  const d = toDate(v);
  return d ? d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) : 'Never';
};
const providerName = (p: string) => (p === 'google.com' ? 'Google' : p === 'password' ? 'Email' : p === 'apple.com' ? 'Apple' : p);

const ACTION_LABELS: Record<string, string> = {
  user_suspended: 'Suspended',
  user_reactivated: 'Reactivated',
  user_deletion_scheduled: 'Scheduled deletion',
  user_restored: 'Restored',
  user_purged: 'Permanently deleted',
  user_approved: 'Approved',
  user_unapproved: 'Access removed',
  request_approved: 'Access request approved',
  request_rejected: 'Access request rejected',
  request_deleted: 'Access request deleted',
};

function StatusBadge({ status }: { status: UserRow['status'] }) {
  if (status === 'active') return <Badge tone="accent">Active</Badge>;
  if (status === 'suspended') return <Badge tone="warn">Suspended</Badge>;
  return <Badge tone="danger">Pending deletion</Badge>;
}

function Avatar({ user, size = 'size-9' }: { user: UserRow; size?: string }) {
  return user.photoURL ? (
    <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className={cn(size, 'shrink-0 rounded-full object-cover')} />
  ) : (
    <div className={cn(size, 'flex shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent')}>{user.name.slice(0, 1).toUpperCase()}</div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="truncate text-xs text-muted" title={hint}>
        {label}
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { admin, user: me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'users' | 'logs'>('users');
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState<'all' | 'google.com' | 'password' | 'apple.com'>('all');
  const [status, setStatus] = useState<'all' | UserRow['status'] | UserRow['accessStatus']>('all');
  const [registered, setRegistered] = useState<'all' | '7' | '30' | '90'>('all');
  const [phone, setPhone] = useState<'all' | 'verified' | 'unverified'>('all');
  const [openUid, setOpenUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ users: UserRow[]; stats: Stats }>('admin', { json: { action: 'list' } });
      setRows(r.users);
      setStats(r.stats);
    } catch (err) {
      setError(err instanceof ApiError ? { code: err.code, message: err.message } : { code: 'failed', message: 'Users could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const r = await api<{ logs: LogEntry[] }>('admin', { json: { action: 'logs' } });
      setLogs(r.logs);
    } catch (err) {
      setLogs([]);
      toast(err instanceof ApiError ? err.message : 'Activity log could not be loaded.', 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);
  useEffect(() => {
    if (admin && tab === 'logs' && logs === null) void loadLogs();
  }, [admin, tab, logs, loadLogs]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    const since = registered === 'all' ? 0 : Date.now() - Number(registered) * 86_400_000;
    return rows.filter(
      (r) =>
        (!needle || r.name.toLowerCase().includes(needle) || (r.email ?? '').toLowerCase().includes(needle) || (r.phoneMasked ?? '').replace(/\D/g, '').includes(needle.replace(/\D/g, '') || '\u0000')) &&
        (provider === 'all' || r.providers.includes(provider)) &&
        (status === 'all' ||
          (status === 'active' || status === 'suspended' || status === 'deleted' ? r.status === status : r.accessStatus === status && r.status === 'active')) &&
        (phone === 'all' || (phone === 'verified') === r.phoneVerified) &&
        (r.createdAt ?? 0) >= since,
    );
  }, [rows, q, provider, status, registered, phone]);

  if (!admin) return <Navigate to="/settings" replace />;

  const afterChange = () => {
    void load();
    setLogs(null);
  };

  return (
    <Page
      title="Users"
      back="/settings"
      wide
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-5xl">
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="User management is not configured">
            {error.message} No user data is shown until this is fixed.
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<Users className="size-6" />} title="Users could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !rows || !stats ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading users
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4 sm:divide-y-0 lg:grid-cols-8 [&>*:nth-child(n+5)]:sm:border-t lg:[&>*:nth-child(n+5)]:border-t-0">
              <Stat label="Total users" value={stats.total} />
              <Stat label="Approved" value={stats.approved} />
              <Stat label="Pending approval" value={stats.pendingApproval} />
              <Stat label="Rejected" value={stats.rejected} />
              <Stat label="Suspended" value={stats.suspended} hint={`${stats.pendingDeletion} pending deletion`} />
              <Stat label={`New (${stats.newDays} days)`} value={stats.newUsers} />
              <Stat label="Google / email" value={stats.google + stats.password} hint={`${stats.google} Google, ${stats.password} email and password`} />
              <Stat label="Phone verified" value={stats.phoneVerified} hint={`${stats.phoneUnverified} without a verified phone; ${stats.phoneRequiredPending} password accounts still need one`} />
            </div>

            <div className="mb-4 flex gap-1 border-b border-border">
              {(['users', 'logs'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn('-mb-px border-b-2 px-3 py-2 text-sm transition-colors', tab === t ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
                >
                  {t === 'users' ? `Users (${rows.length})` : 'Activity log'}
                </button>
              ))}
            </div>

            {tab === 'users' ? (
              <>
                <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
                    <Input aria-label="Search users" placeholder="Search by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex">
                    <Select
                      id="f-provider"
                      value={provider}
                      onChange={setProvider}
                      options={[
                        { value: 'all', label: 'All methods' },
                        { value: 'google.com', label: 'Google' },
                        { value: 'password', label: 'Email' },
                        { value: 'apple.com', label: 'Apple (legacy)' },
                      ]}
                    />
                    <Select
                      id="f-status"
                      value={status}
                      onChange={setStatus}
                      options={[
                        { value: 'all', label: 'All statuses' },
                        { value: 'approved', label: 'Approved' },
                        { value: 'pending', label: 'Pending approval' },
                        { value: 'rejected', label: 'Rejected' },
                        { value: 'active', label: 'Active (not suspended)' },
                        { value: 'suspended', label: 'Suspended' },
                        { value: 'deleted', label: 'Pending deletion' },
                      ]}
                    />
                    <Select
                      id="f-phone"
                      value={phone}
                      onChange={setPhone}
                      options={[
                        { value: 'all', label: 'Any phone' },
                        { value: 'verified', label: 'Phone verified' },
                        { value: 'unverified', label: 'No verified phone' },
                      ]}
                    />
                    <Select
                      id="f-registered"
                      value={registered}
                      onChange={setRegistered}
                      options={[
                        { value: 'all', label: 'Any date' },
                        { value: '7', label: 'Last 7 days' },
                        { value: '30', label: 'Last 30 days' },
                        { value: '90', label: 'Last 90 days' },
                      ]}
                    />
                  </div>
                </div>

                {filtered.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted">{rows.length ? 'No users match these filters.' : 'No users yet.'}</p>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_7rem] gap-3 border-b border-border bg-surface-2 px-4 py-2 text-xs font-medium text-muted md:grid">
                      <span>User</span>
                      <span>Sign-in and phone</span>
                      <span>Registered</span>
                      <span>Last sign-in</span>
                      <span>Status</span>
                    </div>
                    <ul className="divide-y divide-border">
                      {filtered.map((r) => (
                        <li key={r.uid}>
                          <button
                            type="button"
                            onClick={() => setOpenUid(r.uid)}
                            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_7rem]"
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <Avatar user={r} />
                              <span className="min-w-0">
                                <span className="flex items-center gap-1.5 truncate text-[15px]">
                                  <span className="truncate">{r.name}</span>
                                  {r.admin && <Badge>{r.owner ? 'Owner' : 'Admin'}</Badge>}
                                  {r.accessStatus === 'pending' && <Badge tone="warn">Pending approval</Badge>}
                                  {r.accessStatus === 'rejected' && <Badge tone="danger">Rejected</Badge>}
                                </span>
                                <span className="block truncate text-xs text-muted">{r.email ?? 'No email'}</span>
                                <span className="block truncate text-xs text-muted md:hidden">
                                  {r.providers.map(providerName).join(', ')} · {r.phoneMasked ? `${r.phoneMasked}${r.phoneVerified ? ' (verified)' : ''}` : 'No phone'}
                                </span>
                              </span>
                            </span>
                            <span className="hidden min-w-0 text-sm md:block">
                              <span className="block truncate">{r.providers.map(providerName).join(', ') || 'Unknown'}</span>
                              <span className="block truncate text-xs text-muted">{r.phoneMasked ? `${r.phoneMasked}${r.phoneVerified ? ' · verified' : ' · unverified'}` : 'No phone'}</span>
                            </span>
                            <span className="hidden text-sm text-muted md:block">{fmt(r.createdAt)}</span>
                            <span className="hidden text-sm text-muted md:block">{fmt(r.lastLoginAt)}</span>
                            <span className="justify-self-end md:justify-self-start">
                              <StatusBadge status={r.status} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <ActivityLog logs={logs} />
            )}
          </>
        )}
      </div>

      {openUid && <UserDetail uid={openUid} selfUid={me?.uid ?? ''} onClose={() => setOpenUid(null)} onChanged={afterChange} />}
    </Page>
  );
}

function ActivityLog({ logs }: { logs: LogEntry[] | null }) {
  if (logs === null)
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Spinner className="size-4" /> Loading activity
      </div>
    );
  if (!logs.length) return <p className="py-10 text-center text-sm text-muted">No administrator actions recorded yet.</p>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
      {logs.map((l) => (
        <li key={l.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="text-[15px]">
              {ACTION_LABELS[l.action] ?? l.action} <span className="text-muted">·</span> <span className="break-all">{l.targetEmail ?? 'unknown account'}</span>
            </div>
            <div className="truncate text-xs text-muted">
              by {l.adminEmail ?? 'unknown'}
              {l.detail ? ` · ${l.detail}` : ''}
            </div>
          </div>
          <time className="shrink-0 text-xs text-muted tabular-nums">{fmt(l.at, true)}</time>
        </li>
      ))}
    </ul>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

function UserDetail({ uid, selfUid, onClose, onChanged }: { uid: string; selfUid: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [approving, setApproving] = useState(false);
  const [confirmAccess, setConfirmAccess] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<Detail>('admin', { json: { action: 'detail', uid } }));
    } catch (err) {
      setFailed(err instanceof ApiError ? err.message : 'Details could not be loaded.');
    }
  }, [uid]);
  useEffect(() => {
    void load();
  }, [load]);

  const u = detail?.user;
  const self = u?.uid === selfUid;
  const protectedTarget = Boolean(u && (self || u.owner));

  const approve = async (approved: boolean) => {
    setApproving(true);
    try {
      await api('admin', { json: { action: 'approve', uid, approved } });
      toast(approved ? 'Access approved.' : 'Access revoked.', 'success');
      await load();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not change access.', 'error');
    } finally {
      setApproving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} size="lg" title={u ? u.name : 'User'} description={u?.email ?? undefined}>
      {failed ? (
        <p className="py-6 text-sm text-danger">{failed}</p>
      ) : !detail || !u ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> Loading
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <Avatar user={u} size="size-12" />
            <div className="flex flex-wrap gap-1.5">
              <StatusBadge status={u.status} />
              {u.admin && <Badge>{u.owner ? 'Owner' : 'Administrator'}</Badge>}
              <Badge tone={u.approved ? 'neutral' : u.accessStatus === 'rejected' ? 'danger' : 'warn'}>
                {u.approved ? 'Approved' : u.accessStatus === 'rejected' ? 'Rejected' : 'Pending approval'}
              </Badge>
            </div>
          </div>

          <div className="divide-y divide-border">
            <DetailRow label="Sign-in methods">{u.providers.map(providerName).join(', ') || 'Unknown'}</DetailRow>
            <DetailRow label="Email">{u.email ? `${u.email}${u.emailVerified ? ' (verified)' : ' (not verified)'}` : 'None'}</DetailRow>
            <DetailRow label="Phone">{u.phoneMasked ? `${u.phoneMasked}${u.phoneVerified ? ' (verified)' : ' (not verified)'}` : 'None'}</DetailRow>
            <DetailRow label="Registered">{fmt(u.createdAt, true)}</DetailRow>
            <DetailRow label="Last sign-in">{fmt(u.lastLoginAt, true)}</DetailRow>
            {u.status === 'suspended' && <DetailRow label="Suspended">{fmt(detail.account.suspendedAt, true)}</DetailRow>}
            {u.status === 'deleted' && <DetailRow label="Permanent deletion">{u.purgeAfter ? fmt(u.purgeAfter, true) : 'Scheduled'}</DetailRow>}
            <DetailRow label="User ID">
              <code className="text-xs">{u.uid}</code>
            </DetailRow>
          </div>

          <div>
            <h3 className="mb-1.5 text-[13px] font-medium text-muted">Data held</h3>
            <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm sm:grid-cols-6">
              {Object.entries(detail.counts).map(([k, v]) => (
                <div key={k}>
                  <div className="font-medium tabular-nums">{v ?? '-'}</div>
                  <div className="text-xs text-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
                </div>
              ))}
            </div>
          </div>

          {detail.usage && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-medium text-muted">Usage (last {detail.usage.days} recorded days)</h3>
              <p className="text-sm">
                {detail.usage.requests} requests, {formatTokens(detail.usage.tokens)} tokens, active on {detail.usage.activeDays} days
                {detail.usage.lastActive ? `, last ${detail.usage.lastActive}` : ''}.
              </p>
              {detail.usage.topModels.length > 0 && (
                <p className="mt-1 text-xs text-muted">{detail.usage.topModels.map((m) => `${modelShortName(m.model)} (${m.requests})`).join(', ')}</p>
              )}
            </div>
          )}

          {detail.securityEvents.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-medium text-muted">Recent security events</h3>
              <ul className="space-y-1 text-sm">
                {detail.securityEvents.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex justify-between gap-4">
                    <span className="truncate">
                      {e.type.replace(/_/g, ' ')}
                      {e.device ? <span className="text-muted"> · {e.device}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted tabular-nums">{fmt(e.at, true)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.adminLogs.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-medium text-muted">Administrator actions on this account</h3>
              <ul className="space-y-1 text-sm">
                {detail.adminLogs.map((l) => (
                  <li key={l.id} className="flex justify-between gap-4">
                    <span className="truncate">
                      {ACTION_LABELS[l.action] ?? l.action} <span className="text-muted">by {l.adminEmail ?? 'unknown'}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted tabular-nums">{fmt(l.at, true)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {confirmAccess && (
            <ConfirmDialog
              open
              onClose={() => setConfirmAccess(false)}
              onConfirm={async () => {
                setConfirmAccess(false);
                await approve(!u.approved);
              }}
              title={u.approved ? 'Revoke access?' : 'Approve access?'}
              message={
                u.approved
                  ? `${u.email ?? u.name} will lose access to Atlas AI immediately and see an "Access not approved" message. Their data is kept.`
                  : `${u.email ?? u.name} will be able to use Atlas AI the next time they open it.`
              }
              confirmLabel={u.approved ? 'Revoke access' : 'Approve'}
              danger={u.approved}
            />
          )}

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            {!u.owner && u.email && (
              <Button size="sm" variant="outline" loading={approving} onClick={() => setConfirmAccess(true)}>
                {u.approved ? 'Revoke access' : 'Approve access'}
              </Button>
            )}
            {u.status === 'active' && (
              <Button size="sm" variant="outline" disabled={protectedTarget} onClick={() => setAction({ kind: 'suspend', user: u })}>
                Suspend
              </Button>
            )}
            {u.status === 'suspended' && (
              <Button size="sm" variant="outline" disabled={protectedTarget} onClick={() => setAction({ kind: 'reactivate', user: u })}>
                Reactivate
              </Button>
            )}
            {u.status !== 'deleted' ? (
              <Button size="sm" variant="danger" disabled={protectedTarget} onClick={() => setAction({ kind: 'delete', user: u })}>
                Delete account
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" disabled={protectedTarget} onClick={() => setAction({ kind: 'restore', user: u })}>
                  Restore account
                </Button>
                <Button size="sm" variant="danger" disabled={protectedTarget} onClick={() => setAction({ kind: 'purge', user: u })}>
                  Delete permanently now
                </Button>
              </>
            )}
          </div>
          {protectedTarget && <p className="text-xs text-muted">{self ? 'You cannot suspend or delete your own account.' : 'The owner account cannot be suspended or deleted.'}</p>}
        </div>
      )}

      {action && (
        <ActionDialog
          action={action}
          onClose={() => setAction(null)}
          onDone={async () => {
            setAction(null);
            await load();
            onChanged();
          }}
        />
      )}
    </Dialog>
  );
}

/**
 * Confirmation for moderation actions. Deletion asks for the account email;
 * permanent deletion additionally needs an acknowledgement and a second
 * confirmation. The server re-checks every one of these conditions.
 */
function ActionDialog({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const { kind, user } = action;
  const [reason, setReason] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [ack, setAck] = useState(false);
  const [second, setSecond] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expected = (user.email ?? user.uid).toLowerCase();
  const typed = confirmEmail.trim().toLowerCase() === expected;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const body =
        kind === 'suspend'
          ? { action: kind, uid: user.uid, reason: reason.trim() || undefined }
          : kind === 'delete'
            ? { action: kind, uid: user.uid, confirmEmail }
            : kind === 'purge'
              ? { action: kind, uid: user.uid, confirmEmail, acknowledge: true }
              : { action: kind, uid: user.uid };
      await api('admin', { json: body });
      toast(
        kind === 'suspend'
          ? 'Account suspended and signed out everywhere.'
          : kind === 'reactivate'
            ? 'Account reactivated.'
            : kind === 'delete'
              ? 'Account scheduled for deletion in 30 days.'
              : kind === 'restore'
                ? 'Account restored.'
                : 'Account permanently deleted.',
        'success',
      );
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The action failed. Nothing was changed.');
      setSecond(false);
    } finally {
      setBusy(false);
    }
  };

  if (kind === 'reactivate' || kind === 'restore') {
    return (
      <ConfirmDialog
        open
        onClose={onClose}
        onConfirm={run}
        title={kind === 'reactivate' ? 'Reactivate this account?' : 'Restore this account?'}
        message={
          kind === 'reactivate'
            ? `${user.email ?? user.name} will be able to sign in again.`
            : `${user.email ?? user.name} will no longer be deleted and can sign in again. All of their data is still there.`
        }
        confirmLabel={kind === 'reactivate' ? 'Reactivate' : 'Restore'}
      />
    );
  }

  const title = kind === 'suspend' ? 'Suspend account' : kind === 'delete' ? 'Delete account' : 'Delete permanently';
  const canSubmit = kind === 'suspend' || (typed && (kind !== 'purge' || ack));

  return (
    <>
      <Dialog
        open={!second}
        onClose={onClose}
        title={title}
        description={user.email ?? user.name}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant={kind === 'suspend' ? 'primary' : 'danger'} loading={busy} disabled={!canSubmit} onClick={() => (kind === 'purge' ? setSecond(true) : void run())}>
              {kind === 'suspend' ? 'Suspend' : kind === 'delete' ? 'Schedule deletion' : 'Continue'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {kind === 'suspend' && (
            <>
              <p>The user is signed out on every device and cannot sign in or use the app until reactivated. Their data is kept.</p>
              <div>
                <Label htmlFor="suspend-reason">Reason (shown in the activity log)</Label>
                <Textarea id="suspend-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            </>
          )}
          {kind === 'delete' && (
            <p>
              The account is disabled and signed out now, and permanently deleted after 30 days with all conversations, memories and documents. You can restore it until then.
            </p>
          )}
          {kind === 'purge' && (
            <p className="text-danger">
              This removes the account and all of its data immediately: profile, conversations, memories, documents, knowledge sources and sign-in. It cannot be undone.
            </p>
          )}
          {(kind === 'delete' || kind === 'purge') && (
            <div>
              <Label htmlFor="confirm-email">Type {user.email ? 'the email address' : 'the user ID'} to confirm</Label>
              <Input id="confirm-email" autoComplete="off" placeholder={user.email ?? user.uid} value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} />
            </div>
          )}
          {kind === 'purge' && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 accent-[var(--color-danger)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand this permanently deletes the account and cannot be reversed.</span>
            </label>
          )}
          {error && <p className="text-danger">{error}</p>}
        </div>
      </Dialog>
      {kind === 'purge' && (
        <ConfirmDialog
          open={second}
          onClose={() => setSecond(false)}
          onConfirm={run}
          title="Permanently delete now?"
          message={`Last check: ${user.email ?? user.uid} and all of their data will be erased.`}
          confirmLabel="Delete permanently"
          danger
        />
      )}
    </>
  );
}
