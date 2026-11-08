import { RefreshCw, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, Label, Select, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

/** Mirrors AdminRequestRow in server/account/requests.ts. */
interface RequestRow {
  uid: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  authProvider: string;
  phoneVerified: boolean;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  history: { status: string; at: number; by?: string | null; note?: string | null }[];
  accountStatus: string;
  accessStatus: string;
}

interface Stats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  recent: number;
}

type Kind = 'approve' | 'reject' | 'suspend' | 'reactivate' | 'delete';

const fmt = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const providerName = (p: string) => (p === 'google.com' ? 'Google' : p === 'password' ? 'Email and password' : p);
/** Tell other views (the sidebar badge) that request counts changed. */
const changed = () => window.dispatchEvent(new Event('atlas:requests-changed'));

function StatusBadge({ r }: { r: RequestRow }) {
  if (r.accountStatus === 'suspended') return <Badge tone="warn">Suspended</Badge>;
  if (r.status === 'pending') return <Badge tone="warn">Pending</Badge>;
  if (r.status === 'approved') return <Badge tone="accent">Approved</Badge>;
  return <Badge tone="danger">Rejected</Badge>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export default function AccessRequestsPage() {
  const { admin } = useAuth();
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | RequestRow['status']>('pending');
  const [openUid, setOpenUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ requests: RequestRow[]; stats: Stats }>('admin', { json: { action: 'requests' } });
      setRows(r.requests);
      setStats(r.stats);
    } catch (err) {
      setError(err instanceof ApiError ? { code: err.code, message: err.message } : { code: 'failed', message: 'Access requests could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    return rows.filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        (!needle || r.fullName.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle) || (digits.length > 2 && (r.phoneNumber ?? '').includes(digits))),
    );
  }, [rows, q, status]);

  if (!admin) return <Navigate to="/settings" replace />;
  const open = rows?.find((r) => r.uid === openUid) ?? null;

  return (
    <Page
      title="Access requests"
      back="/settings"
      wide
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-5xl">
        {error?.code === 'admin_unconfigured' || error?.code === 'admin_unavailable' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Access requests are not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<UserPlus className="size-6" />} title="Access requests could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !rows || !stats ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading requests
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-5 sm:divide-y-0">
              <Stat label="Total requests" value={stats.total} />
              <Stat label="Pending" value={stats.pending} />
              <Stat label="Approved" value={stats.approved} />
              <Stat label="Rejected" value={stats.rejected} />
              <Stat label="Last 7 days" value={stats.recent} />
            </div>

            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
                <Input aria-label="Search requests" placeholder="Search by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
              </div>
              <Select
                id="f-request-status"
                value={status}
                onChange={setStatus}
                className="sm:w-44"
                options={[
                  { value: 'pending', label: 'Pending' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'rejected', label: 'Rejected' },
                  { value: 'all', label: 'All requests' },
                ]}
              />
            </div>

            {filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">
                {rows.length ? (status === 'pending' && !q ? 'No requests are waiting for review.' : 'No requests match these filters.') : 'No access requests yet.'}
              </p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border">
                <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem] gap-3 border-b border-border bg-surface-2 px-4 py-2 text-xs font-medium text-muted md:grid">
                  <span>Applicant</span>
                  <span>Phone</span>
                  <span>Sign-in</span>
                  <span>Requested</span>
                  <span>Status</span>
                </div>
                <ul className="divide-y divide-border">
                  {filtered.map((r) => (
                    <li key={r.uid}>
                      <button
                        type="button"
                        onClick={() => setOpenUid(r.uid)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[15px]">{r.fullName}</span>
                          <span className="block truncate text-xs text-muted">{r.email}</span>
                          <span className="block truncate text-xs text-muted md:hidden">
                            {r.phoneNumber ?? 'No phone'} · {fmt(r.submittedAt)}
                          </span>
                        </span>
                        <span className="hidden min-w-0 text-sm md:block">
                          <span className="block truncate tabular-nums">{r.phoneNumber ?? 'None'}</span>
                          <span className="block text-xs text-muted">{r.phoneVerified ? 'Verified' : 'Not verified'}</span>
                        </span>
                        <span className="hidden truncate text-sm text-muted md:block">{providerName(r.authProvider)}</span>
                        <span className="hidden text-sm text-muted md:block">{fmt(r.submittedAt)}</span>
                        <span className="justify-self-end md:justify-self-start">
                          <StatusBadge r={r} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      {open && (
        <RequestDetail
          r={open}
          onClose={() => setOpenUid(null)}
          onChanged={() => {
            changed();
            void load();
          }}
        />
      )}
    </Page>
  );
}

function RequestDetail({ r, onClose, onChanged }: { r: RequestRow; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind | null>(null);
  const [note, setNote] = useState('');

  const run = async () => {
    const k = kind!;
    try {
      if (k === 'approve' || k === 'reject') await api('admin', { json: { action: 'requestDecision', uid: r.uid, decision: k, note: note.trim() || undefined } });
      else if (k === 'delete') await api('admin', { json: { action: 'requestDelete', uid: r.uid } });
      else await api('admin', { json: { action: k, uid: r.uid, ...(k === 'suspend' && note.trim() ? { reason: note.trim() } : {}) } });
      const done: Record<Kind, string> = {
        approve: 'Request approved. The applicant can now use Atlas AI.',
        reject: 'Request rejected.',
        suspend: 'Account suspended.',
        reactivate: 'Account reactivated.',
        delete: 'Request deleted.',
      };
      toast(done[k], 'success');
      setKind(null);
      setNote('');
      onChanged();
      if (k === 'delete') onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work. Please try again.', 'error');
      setKind(null);
    }
  };

  const suspended = r.accountStatus === 'suspended';
  const approvedNow = r.accessStatus === 'approved' || r.status === 'approved';
  const confirmCopy: Record<Kind, { title: string; message: string; label: string; danger: boolean }> = {
    approve: { title: 'Approve this request?', message: `${r.email} will be able to use Atlas AI the next time they open it.`, label: 'Approve', danger: false },
    reject: { title: 'Reject this request?', message: `${r.email} will not be able to use Atlas AI and will see that the request was not approved.`, label: 'Reject', danger: true },
    suspend: { title: 'Suspend this account?', message: `${r.email} will be signed out everywhere and blocked until reactivated. Their data is kept.`, label: 'Suspend', danger: true },
    reactivate: { title: 'Reactivate this account?', message: `${r.email} will be able to sign in again.`, label: 'Reactivate', danger: false },
    delete: { title: 'Delete this request?', message: `The request record is removed. The account is not deleted, and ${r.email} may submit a new request.`, label: 'Delete request', danger: true },
  };

  return (
    <Dialog open onClose={onClose} title={r.fullName} size="md">
      <div className="space-y-5">
        <div className="divide-y divide-border">
          <Field label="Email">{r.email}</Field>
          <Field label="Phone">
            {r.phoneNumber ?? 'Not provided'} {r.phoneNumber && <span className="text-muted">({r.phoneVerified ? 'verified' : 'not verified'})</span>}
          </Field>
          <Field label="Sign-in method">{providerName(r.authProvider)}</Field>
          <Field label="Submitted">{fmt(r.submittedAt)}</Field>
          <Field label="Status">
            <StatusBadge r={r} />
          </Field>
          {r.reviewedAt && (
            <Field label="Reviewed">
              {fmt(r.reviewedAt)} by {r.reviewedBy ?? 'unknown'}
              {r.reviewNote && <span className="block text-muted">Note: {r.reviewNote}</span>}
            </Field>
          )}
          <Field label="Reason">{r.reason ? <span className="whitespace-pre-wrap">{r.reason}</span> : <span className="text-muted">None given</span>}</Field>
        </div>

        {r.history.length > 1 && (
          <div>
            <h3 className="mb-1.5 text-[13px] font-medium text-muted">History</h3>
            <ul className="space-y-1 text-sm">
              {r.history.map((h, i) => (
                <li key={i} className="flex justify-between gap-4">
                  <span className="truncate">
                    {h.status === 'submitted' ? 'Submitted' : h.status === 'approved' ? 'Approved' : 'Rejected'}
                    {h.by && <span className="text-muted"> by {h.by}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">{fmt(h.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          {!approvedNow && (
            <Button size="sm" variant="primary" onClick={() => setKind('approve')}>
              Approve
            </Button>
          )}
          {r.status !== 'rejected' && (
            <Button size="sm" variant="outline" onClick={() => setKind('reject')}>
              {approvedNow ? 'Revoke access' : 'Reject'}
            </Button>
          )}
          {approvedNow && !suspended && (
            <Button size="sm" variant="outline" onClick={() => setKind('suspend')}>
              Suspend account
            </Button>
          )}
          {suspended && (
            <Button size="sm" variant="outline" onClick={() => setKind('reactivate')}>
              Reactivate account
            </Button>
          )}
          <Link to={`/admin/users?uid=${encodeURIComponent(r.uid)}`} className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-accent hover:bg-accent-soft">
            View account
          </Link>
          <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => setKind('delete')}>
            Delete request
          </Button>
        </div>
      </div>

      {kind && (kind === 'reject' || kind === 'suspend') ? (
        <Dialog
          open
          onClose={() => setKind(null)}
          title={confirmCopy[kind].title}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setKind(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void run()}>
                {confirmCopy[kind].label}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-muted">{confirmCopy[kind].message}</p>
          <Label htmlFor="decision-note" hint="Optional, visible to administrators only">
            {kind === 'suspend' ? 'Reason' : 'Note'}
          </Label>
          <Textarea id="decision-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Dialog>
      ) : kind ? (
        <ConfirmDialog
          open
          onClose={() => setKind(null)}
          onConfirm={run}
          title={confirmCopy[kind].title}
          message={confirmCopy[kind].message}
          confirmLabel={confirmCopy[kind].label}
          danger={confirmCopy[kind].danger}
        />
      ) : null}
    </Dialog>
  );
}
