import { ChevronLeft, ChevronRight, LifeBuoy, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Button, EmptyState, IconButton, Input, Select, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { categoryLabel, statusLabel, SUPPORT_CATEGORIES, SUPPORT_PRIORITIES, SUPPORT_STATUSES, priorityLabel, type SupportReportAdminView, type SupportStats } from '@shared/support';
import { Page } from '../shell/Page';
import { supportApi } from '../support/api';
import { errorText, fmtDate, PriorityBadge, StatusBadge } from '../support/parts';

const PAGE = 25;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
type Sort = 'updated' | 'created' | 'priority' | 'oldest';

function Stat({ label, value, active, onClick }: { label: string; value: number; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn('min-w-0 px-4 py-3 text-left transition-colors hover:bg-surface-2', active && 'bg-accent-soft')}>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </button>
  );
}

export default function SupportAdminPage() {
  const { admin, user } = useAuth();
  const [rows, setRows] = useState<SupportReportAdminView[] | null>(null);
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('open');
  const [category, setCategory] = useState<string>('all');
  const [priority, setPriority] = useState<string>('all');
  const [assigned, setAssigned] = useState<string>('all');
  const [sort, setSort] = useState<Sort>('updated');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await supportApi.adminList();
      setRows(r.reports);
      setStats(r.stats);
    } catch (err) {
      setError({ code: (err as { code?: string }).code ?? 'failed', message: errorText(err, 'Reports could not be loaded.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!admin) return;
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('atlas:notified', load);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('atlas:notified', load);
    };
  }, [admin, load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    const me = user?.email?.toLowerCase();
    const out = rows.filter(
      (r) =>
        (status === 'all' || (status === 'open' ? r.status !== 'closed' && r.status !== 'resolved' : r.status === status)) &&
        (category === 'all' || r.category === category) &&
        (priority === 'all' || r.priority === priority) &&
        (assigned === 'all' || (assigned === 'me' ? r.assignedTo === me : assigned === 'none' ? !r.assignedTo : r.assignedTo === assigned)) &&
        (!needle || [r.ref, r.title, r.userName, r.userEmail, r.description].some((f) => f.toLowerCase().includes(needle))),
    );
    return out.sort((a, b) =>
      sort === 'created' ? b.createdAt - a.createdAt : sort === 'oldest' ? a.createdAt - b.createdAt : sort === 'priority' ? PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt,
    );
  }, [rows, q, status, category, priority, assigned, sort, user]);

  useEffect(() => setPage(0), [q, status, category, priority, assigned, sort]);

  if (!admin) return <Navigate to="/settings" replace />;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const filterStatus = (s: string) => setStatus((cur) => (cur === s ? 'all' : s));

  return (
    <Page
      title="Support"
      wide
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">Support & issue reports</h1>
          <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Support is not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<LifeBuoy className="size-6" />} title="Reports could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !rows || !stats ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading reports
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4">
              <Stat label="Total reports" value={stats.total} active={status === 'all'} onClick={() => setStatus('all')} />
              <Stat label="New" value={stats.new} active={status === 'new'} onClick={() => filterStatus('new')} />
              <Stat label="Pending" value={stats.pending} active={status === 'pending'} onClick={() => filterStatus('pending')} />
              <Stat label="Under review" value={stats.underReview} active={status === 'under_review'} onClick={() => filterStatus('under_review')} />
              <Stat label="Awaiting user response" value={stats.awaitingUser} active={status === 'awaiting_user'} onClick={() => filterStatus('awaiting_user')} />
              <Stat label="Resolved" value={stats.resolved} active={status === 'resolved'} onClick={() => filterStatus('resolved')} />
              <Stat label="Closed" value={stats.closed} active={status === 'closed'} onClick={() => filterStatus('closed')} />
              <Stat
                label="Feature requests"
                value={stats.featureRequests}
                active={category === 'feature_request'}
                onClick={() => {
                  setStatus('all');
                  setCategory((c) => (c === 'feature_request' ? 'all' : 'feature_request'));
                }}
              />
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-[minmax(0,1fr)_10rem_11rem_8rem_9rem_9rem]">
              <div className="relative col-span-2 lg:col-span-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
                <Input aria-label="Search reports" placeholder="Search reference, title, name or email" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
              </div>
              <Select
                id="f-support-status"
                value={status}
                onChange={setStatus}
                options={[{ value: 'open', label: 'Open reports' }, { value: 'all', label: 'All statuses' }, ...SUPPORT_STATUSES.map((s) => ({ value: s.id as string, label: statusLabel(s.id, true) }))]}
              />
              <Select id="f-support-category" value={category} onChange={setCategory} options={[{ value: 'all', label: 'All categories' }, ...SUPPORT_CATEGORIES.map((c) => ({ value: c.id as string, label: c.label }))]} />
              <Select id="f-support-priority" value={priority} onChange={setPriority} options={[{ value: 'all', label: 'Any priority' }, ...SUPPORT_PRIORITIES.map((p) => ({ value: p as string, label: priorityLabel(p) }))]} />
              <Select
                id="f-support-assigned"
                value={assigned}
                onChange={setAssigned}
                options={[
                  { value: 'all', label: 'Anyone' },
                  { value: 'me', label: 'Assigned to me' },
                  { value: 'none', label: 'Unassigned' },
                ]}
              />
              <Select<Sort>
                id="f-support-sort"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'updated', label: 'Recently updated' },
                  { value: 'created', label: 'Newest first' },
                  { value: 'oldest', label: 'Oldest first' },
                  { value: 'priority', label: 'Priority' },
                ]}
              />
            </div>

            {filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">{rows.length ? 'No reports match these filters.' : 'No reports yet.'}</p>
            ) : (
              <>
                <div className="overflow-hidden rounded-2xl border border-border">
                  <div className="hidden grid-cols-[7.5rem_minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_5.5rem_8.5rem_minmax(0,1fr)_6.5rem] gap-3 border-b border-border bg-surface-2 px-4 py-2 text-xs font-medium text-muted lg:grid">
                    <span>Reference</span>
                    <span>User</span>
                    <span>Title</span>
                    <span>Category</span>
                    <span>Priority</span>
                    <span>Status</span>
                    <span>Assigned</span>
                    <span>Updated</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {shown.map((r) => (
                      <li key={r.ref}>
                        <Link
                          to={`/admin/support/${r.ref}`}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-surface-2 lg:grid-cols-[7.5rem_minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_5.5rem_8.5rem_minmax(0,1fr)_6.5rem]"
                        >
                          <span className="hidden font-mono text-xs lg:block">{r.ref}</span>
                          <span className="hidden min-w-0 lg:block">
                            <span className="block truncate">{r.userName}</span>
                            <span className="block truncate text-xs text-muted">{r.userEmail}</span>
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium lg:font-normal">
                              {r.lastMessageBy === 'user' && r.status !== 'closed' && <span className="mr-1.5 inline-block size-2 rounded-full bg-accent align-middle" title="Waiting for a reply" />}
                              {r.title}
                            </span>
                            <span className="block truncate text-xs text-muted lg:hidden">
                              <span className="font-mono">{r.ref}</span> · {r.userName} · {categoryLabel(r.category)}
                            </span>
                            <span className="block text-xs text-subtle lg:hidden">
                              {fmtDate(r.updatedAt)}
                              {r.assignedTo ? ` · ${r.assignedTo}` : ''}
                            </span>
                          </span>
                          <span className="hidden truncate text-muted lg:block">{categoryLabel(r.category)}</span>
                          <span className="hidden lg:block">
                            <PriorityBadge priority={r.priority} />
                          </span>
                          <span className="flex flex-col items-end gap-1 lg:block">
                            <StatusBadge status={r.status} admin />
                            <span className="lg:hidden">
                              <PriorityBadge priority={r.priority} />
                            </span>
                          </span>
                          <span className="hidden truncate text-xs text-muted lg:block">{r.assignedTo ?? 'Unassigned'}</span>
                          <span className="hidden text-xs text-muted lg:block">
                            {fmtDate(r.updatedAt, false)}
                            <span className="block text-subtle">Sent {fmtDate(r.createdAt, false)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-3 flex items-center justify-between text-sm text-muted">
                  <span>
                    {page * PAGE + 1}–{Math.min(filtered.length, page * PAGE + PAGE)} of {filtered.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <IconButton label="Previous page" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                      <ChevronLeft className="size-4" />
                    </IconButton>
                    <span className="tabular-nums">
                      {page + 1} / {pages}
                    </span>
                    <IconButton label="Next page" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>
                      <ChevronRight className="size-4" />
                    </IconButton>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
