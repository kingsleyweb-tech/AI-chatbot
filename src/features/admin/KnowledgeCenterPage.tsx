import { Archive, BookCheck, Check, FilePlus2, Globe, Merge, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, Label, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Page } from '../shell/Page';

/* ------------------------------ types (mirror server/central/types.ts) ------------------------------ */

type Status = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'ARCHIVED';
type Perm = 'view' | 'submit' | 'edit' | 'review' | 'delete' | 'categories' | 'intelligence';
const PERMS: Perm[] = ['view', 'submit', 'edit', 'review', 'delete', 'categories', 'intelligence'];
const PERM_LABEL: Record<Perm, string> = { view: 'View', submit: 'Submit', edit: 'Edit', review: 'Approve / reject', delete: 'Delete permanently', categories: 'Manage categories', intelligence: 'Intelligence' };

interface Source {
  url: string;
  title: string;
  publisher: string;
  tier: string;
  reachable: boolean | null;
  supports: boolean | null;
  checkedAt: number | null;
}
interface Assessment {
  at: number;
  by: 'ai' | 'rules';
  score: number;
  verdict: string;
  reasons: string[];
  uncertainties: string[];
}
interface Rec {
  id: string;
  title: string;
  content: string;
  categoryId: string | null;
  tags: string[];
  status: Status;
  confidence: number;
  sources: Source[];
  origin: string;
  assessment: Assessment | null;
  flags: string[];
  duplicateOf: string | null;
  mergedFrom: string[];
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  verifiedAt: number | null;
  verifiedBy: string | null;
  reviewAt: number | null;
  rejectedReason: string | null;
  version: number;
  hasVector: boolean;
}
interface Category {
  id: string;
  name: string;
  description: string;
  count: number;
  reviewDays: number | null;
}
interface Overview {
  total: number;
  byStatus: Record<Status, number>;
  byCategory: { id: string; name: string; count: number }[];
  flags: Record<string, number>;
  averageConfidence: number | null;
  dueForReview: number;
  last30Days: Record<string, number>;
  today: { assessments: number; cap: number };
  maintenance: { at: number; reviewDue: number; newlyFlagged: number; sourcesChecked: number; discovered: number } | null;
  settings: { retrievalEnabled: boolean; discoveryFromWebSearch: boolean; topicInsights: boolean };
  role: 'super' | 'knowledge_admin';
  permissions: 'all' | Perm[];
}
interface Settings {
  admins: Record<string, Perm[]>;
  reviewDays: number;
  retrievalEnabled: boolean;
  discoveryFromWebSearch: boolean;
  discoveryDailyCap: number;
  topicInsights: boolean;
  assessmentsDailyCap: number;
}

const FLAG_LABEL: Record<string, string> = {
  pii_redacted: 'Personal details removed',
  duplicate_suspected: 'Possible duplicate',
  source_unreachable: 'Source unreachable',
  source_unsupported: 'Source does not mention it',
  low_credibility: 'Low-credibility sources',
  no_sources: 'No sources',
  conflict_suspected: 'May contradict verified knowledge',
  review_due: 'Review due',
  ai_unavailable: 'Checked by rules only',
};
const STATUS_TONE: Record<Status, 'accent' | 'warn' | 'danger' | 'neutral'> = { VERIFIED: 'accent', PENDING: 'warn', REJECTED: 'danger', ARCHIVED: 'neutral' };
const STATUS_LABEL: Record<Status, string> = { VERIFIED: 'Verified', PENDING: 'Pending', REJECTED: 'Rejected', ARCHIVED: 'Archived' };
const fmt = (t?: number | null) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const kc = <T,>(body: Record<string, unknown>) => api<T>('knowledge', { json: body });
const errText = (e: unknown, d: string) => (e instanceof ApiError ? e.message : d);

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={hint}>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </div>
  );
}

type Tab = 'overview' | 'queue' | 'records' | 'categories' | 'intelligence' | 'activity' | 'settings';

/* ------------------------------ page ------------------------------ */

export default function KnowledgeCenterPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [categories, setCategories] = useState<Category[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<'manual' | 'url' | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, c] = await Promise.all([kc<Overview>({ action: 'kcOverview' }), kc<{ categories: Category[] }>({ action: 'kcCategories' })]);
      setOverview(o);
      setCategories(c.categories);
    } catch (e) {
      setError({ code: e instanceof ApiError ? e.code : 'failed', message: errText(e, 'Knowledge management could not be loaded.') });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, reload]);

  const can = useCallback((p: Perm | 'settings') => (overview ? overview.permissions === 'all' || (p !== 'settings' && overview.permissions.includes(p)) : false), [overview]);
  const changed = () => setReload((n) => n + 1);

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'overview', label: 'Overview', show: true },
    { id: 'queue', label: `Review queue${overview?.byStatus.PENDING ? ` (${overview.byStatus.PENDING})` : ''}`, show: true },
    { id: 'records', label: 'Explorer', show: true },
    { id: 'categories', label: 'Categories', show: true },
    { id: 'intelligence', label: 'Intelligence', show: can('intelligence') },
    { id: 'activity', label: 'Activity', show: true },
    { id: 'settings', label: 'Settings', show: can('settings') },
  ];

  const actions = (
    <div className="flex gap-2">
      {can('submit') && (
        <>
          <Button size="sm" variant="ghost" icon={<Globe className="size-4" />} onClick={() => setCreating('url')}>
            From a page
          </Button>
          <Button size="sm" icon={<FilePlus2 className="size-4" />} onClick={() => setCreating('manual')}>
            New record
          </Button>
        </>
      )}
    </div>
  );

  return (
    <Page title="Atlas Knowledge Management" back="/settings" wide actions={overview ? actions : undefined}>
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-4 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">Atlas Knowledge Management</h1>
          {overview && actions}
        </div>
        {error ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title={error.code === 'forbidden' ? 'No access' : 'Could not load'} action={error.code === 'forbidden' ? undefined : <Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !overview ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading
          </div>
        ) : (
          <>
            <div className="-mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-border px-4" role="tablist">
              {tabs
                .filter((t) => t.show)
                .map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors', tab === t.id ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
                  >
                    {t.label}
                  </button>
                ))}
            </div>
            {tab === 'overview' && <OverviewTab o={overview} />}
            {tab === 'queue' && <RecordsTab key={`q${reload}`} categories={categories} preset="PENDING" onOpen={setOpen} />}
            {tab === 'records' && <RecordsTab key={`r${reload}`} categories={categories} onOpen={setOpen} />}
            {tab === 'categories' && <CategoriesTab categories={categories} can={can} superAdmin={overview.role === 'super'} onChanged={changed} />}
            {tab === 'intelligence' && <IntelligenceTab onOpen={setOpen} />}
            {tab === 'activity' && <ActivityTab key={reload} />}
            {tab === 'settings' && <SettingsTab onChanged={changed} />}
          </>
        )}
      </div>
      {open && <RecordDialog id={open} categories={categories} can={can} onClose={() => setOpen(null)} onChanged={changed} onOpen={setOpen} />}
      {creating && <CreateDialog mode={creating} categories={categories} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); changed(); if (id) setOpen(id); }} />}
    </Page>
  );
}

/* ------------------------------ overview ------------------------------ */

function OverviewTab({ o }: { o: Overview }) {
  return (
    <>
      <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4">
        <Stat label="Records" value={o.total} />
        <Stat label="Verified (used in answers)" value={o.byStatus.VERIFIED} />
        <Stat label="Waiting for review" value={o.byStatus.PENDING} />
        <Stat label="Due for re-review" value={o.dueForReview} />
        <Stat label="Rejected" value={o.byStatus.REJECTED} />
        <Stat label="Archived" value={o.byStatus.ARCHIVED} />
        <Stat label="Average confidence (verified)" value={o.averageConfidence == null ? '–' : `${Math.round(o.averageConfidence * 100)}%`} />
        <Stat label="Times used in answers (30 days)" value={o.last30Days.retrievals ?? 0} />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-semibold">Last 30 days</h2>
          <dl className="divide-y divide-border rounded-2xl border border-border text-sm">
            {[
              ['Submitted', o.last30Days.submitted],
              ['Approved', o.last30Days.approved],
              ['Rejected', o.last30Days.rejected],
              ['Refused by screening (personal data, secrets, AI instructions)', o.last30Days.refused],
              ['Exact duplicates refused', o.last30Days.duplicates],
              ['Automatic reviews (AI)', o.last30Days.assessments],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3 px-4 py-2">
                <dt className="text-muted">{k}</dt>
                <dd className="tabular-nums">{v ?? 0}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 px-4 py-2">
              <dt className="text-muted">Automatic reviews today</dt>
              <dd className="tabular-nums">
                {o.today.assessments} / {o.today.cap}
              </dd>
            </div>
          </dl>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">By category</h2>
          {o.byCategory.length ? (
            <ul className="divide-y divide-border rounded-2xl border border-border text-sm">
              {o.byCategory.map((c) => (
                <li key={c.id || 'none'} className="flex justify-between px-4 py-2">
                  <span>{c.name}</span>
                  <span className="tabular-nums text-muted">{c.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No categories yet.</p>
          )}
          <h2 className="mb-2 mt-5 text-sm font-semibold">Needs attention</h2>
          {Object.keys(o.flags).length ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(o.flags).map(([f, n]) => (
                <Badge key={f} tone={f === 'pii_redacted' || f === 'ai_unavailable' ? 'neutral' : 'warn'}>
                  {FLAG_LABEL[f] ?? f}: {n}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Nothing flagged.</p>
          )}
          <p className="mt-5 text-xs text-muted">
            Answers use verified records: {o.settings.retrievalEnabled ? 'on' : 'off'} · Discovery from web searches: {o.settings.discoveryFromWebSearch ? 'on' : 'off'} · Topic insights: {o.settings.topicInsights ? 'on' : 'off'}
            {o.maintenance ? ` · Last maintenance ${fmt(o.maintenance.at)} (${o.maintenance.reviewDue} due, ${o.maintenance.discovered} discovered)` : ' · Maintenance has not run yet'}
          </p>
        </section>
      </div>
    </>
  );
}

/* ------------------------------ explorer / queue ------------------------------ */

function RecordsTab({ categories, preset, onOpen }: { categories: Category[]; preset?: Status; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status | 'ALL'>(preset ?? 'ALL');
  const [category, setCategory] = useState('*');
  const [flag, setFlag] = useState('*');
  const [sort, setSort] = useState<'updated' | 'created' | 'confidence' | 'title'>(preset ? 'created' : 'updated');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Rec[]; pageSize: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      kc<{ total: number; rows: Rec[]; pageSize: number }>({
        action: 'kcList',
        q: q || undefined,
        status,
        categoryId: category === '*' ? undefined : category,
        flag: flag === '*' ? undefined : flag,
        sort,
        dir: sort === 'title' ? 'asc' : preset ? 'asc' : 'desc',
        page,
        pageSize: 25,
      })
        .then((d) => live && (setData(d), setErr(null)))
        .catch((e) => live && setErr(errText(e, 'Records could not be loaded.')));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, status, category, flag, sort, page, preset]);

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      {preset && <p className="mb-3 text-sm text-muted">Nothing here is used in answers until an administrator approves it. Check the assessment, flags and sources before deciding.</p>}
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} placeholder="Search title, content, tags or id" className="pl-9" aria-label="Search records" />
        </div>
        {!preset && (
          <Select
            value={status}
            onChange={(v) => (setStatus(v), setPage(1))}
            options={[{ value: 'ALL', label: 'All statuses' }, ...(['VERIFIED', 'PENDING', 'REJECTED', 'ARCHIVED'] as Status[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
          />
        )}
        <Select value={category} onChange={(v) => (setCategory(v), setPage(1))} options={[{ value: '*', label: 'All categories' }, { value: '', label: 'Uncategorised' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
        <Select value={flag} onChange={(v) => (setFlag(v), setPage(1))} options={[{ value: '*', label: 'Any flags' }, ...Object.entries(FLAG_LABEL).map(([k, v]) => ({ value: k, label: v }))]} />
        <Select
          value={sort}
          onChange={setSort}
          options={[
            { value: 'updated', label: 'Recently changed' },
            { value: 'created', label: preset ? 'Oldest first' : 'Newest' },
            { value: 'confidence', label: 'Confidence' },
            { value: 'title', label: 'Title A–Z' },
          ]}
        />
      </div>
      {err && <p className="mb-2 text-sm text-danger">{err}</p>}
      {!data ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> Loading
        </div>
      ) : data.rows.length === 0 ? (
        <EmptyState icon={<BookCheck className="size-6" />} title={preset ? 'Nothing waiting for review' : 'No records match'}>
          {preset ? 'New submissions and discoveries appear here.' : 'Try other filters.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {data.rows.map((r) => (
            <li key={r.id}>
              <button className="w-full px-4 py-3 text-left transition-colors hover:bg-surface-2" onClick={() => onOpen(r.id)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.title}</span>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  <span className="text-xs tabular-nums text-muted">{Math.round(r.confidence * 100)}% confidence</span>
                  {r.flags
                    .filter((f) => f !== 'ai_unavailable')
                    .map((f) => (
                      <Badge key={f} tone="warn">
                        {FLAG_LABEL[f] ?? f}
                      </Badge>
                    ))}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted">{r.content}</p>
                <p className="mt-1 text-xs text-subtle">
                  {r.categoryId ? (catName.get(r.categoryId) ?? 'Unknown category') : 'Uncategorised'} · {r.sources.length} source{r.sources.length === 1 ? '' : 's'} · changed {fmt(r.updatedAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-muted">
            {data.total} records · page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------ record dialog ------------------------------ */

function RecordDialog({ id, categories, can, onClose, onChanged, onOpen }: { id: string; categories: Category[]; can: (p: Perm) => boolean; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const [data, setData] = useState<{ record: Rec; duplicate: { id: string; title: string; status: Status; content: string } | null; audit: { id: string; at: number; action: string; actorEmail: string | null; detail: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', tags: '', categoryId: '', addSource: '' });
  const [confirm, setConfirm] = useState<null | 'delete' | 'ack'>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [mergeId, setMergeId] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await kc<NonNullable<typeof data>>({ action: 'kcGet', id });
      setData(d);
      setForm({ title: d.record.title, content: d.record.content, tags: d.record.tags.join(', '), categoryId: d.record.categoryId ?? '', addSource: '' });
      setErr(null);
    } catch (e) {
      setErr(errText(e, 'The record could not be loaded.'));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await kc<{ ok?: boolean; messages?: string[] }>({ id, ...body });
      if (res.ok === false) {
        setErr(res.messages?.join(' ') ?? 'Not saved.');
        return false;
      }
      onChanged();
      await load();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'needs_acknowledgement') {
        setConfirm('ack');
        return false;
      }
      setErr(errText(e, 'The action failed.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const r = data?.record;
  const footer = r && (
    <div className="flex flex-wrap justify-end gap-2">
      {can('review') && r.status === 'PENDING' && (
        <>
          <Button variant="ghost" icon={<X className="size-4" />} disabled={busy} onClick={() => void run({ action: 'kcStatus', to: 'reject', reason: rejectReason || undefined })}>
            Reject
          </Button>
          <Button icon={<Check className="size-4" />} disabled={busy} onClick={() => void run({ action: 'kcStatus', to: 'approve' })}>
            Approve
          </Button>
        </>
      )}
      {can('review') && r.status === 'VERIFIED' && (
        <Button variant="ghost" icon={<Archive className="size-4" />} disabled={busy} onClick={() => void run({ action: 'kcStatus', to: 'archive' })}>
          Archive
        </Button>
      )}
      {can('review') && (r.status === 'REJECTED' || r.status === 'ARCHIVED') && (
        <Button variant="ghost" icon={<RotateCcw className="size-4" />} disabled={busy} onClick={() => void run({ action: 'kcStatus', to: 'restore' })}>
          Back to review
        </Button>
      )}
      {can('review') && (
        <Button variant="ghost" icon={<RefreshCw className="size-4" />} disabled={busy} onClick={() => void run({ action: 'kcReverify' })}>
          Re-verify
        </Button>
      )}
      {can('delete') && (
        <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={busy} onClick={() => setConfirm('delete')}>
          Delete
        </Button>
      )}
    </div>
  );

  return (
    <Dialog open onClose={onClose} size="lg" title={r ? r.title : 'Record'} footer={footer}>
      {!data ? (
        err ? <p className="text-sm text-danger">{err}</p> : <Spinner className="size-4" />
      ) : (
        r && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
              <span className="tabular-nums text-muted">{Math.round(r.confidence * 100)}% confidence</span>
              {r.flags.map((f) => (
                <Badge key={f} tone={f === 'pii_redacted' || f === 'ai_unavailable' ? 'neutral' : 'warn'}>
                  {FLAG_LABEL[f] ?? f}
                </Badge>
              ))}
            </div>
            {err && <p className="text-danger">{err}</p>}

            {editing ? (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="kc-title">Title</Label>
                  <Input id="kc-title" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="kc-content" hint={r.status === 'VERIFIED' ? 'Changing the content sends the record back to review.' : undefined}>
                    Content
                  </Label>
                  <Textarea id="kc-content" rows={7} value={form.content} maxLength={4000} onChange={(e) => setForm({ ...form, content: e.target.value })} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="kc-tags">Tags (comma separated)</Label>
                    <Input id="kc-tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
                  </div>
                  <div>
                    <Label>Category</Label>
                    <Select value={form.categoryId} onChange={(v) => setForm({ ...form, categoryId: v })} options={[{ value: '', label: 'Uncategorised' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="kc-src">Add a source (https)</Label>
                  <Input id="kc-src" type="url" value={form.addSource} onChange={(e) => setForm({ ...form, addSource: e.target.value })} placeholder="https://" />
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run({
                        action: 'kcUpdate',
                        title: form.title,
                        content: form.content,
                        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
                        categoryId: form.categoryId,
                        ...(form.addSource.trim() ? { addSources: [form.addSource.trim()] } : {}),
                      }).then((ok) => ok && setEditing(false))
                    }
                  >
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap leading-relaxed">{r.content}</p>
                <p className="text-xs text-muted">
                  {r.categoryId ? (categories.find((c) => c.id === r.categoryId)?.name ?? 'Unknown category') : 'Uncategorised'}
                  {r.tags.length ? ` · ${r.tags.join(', ')}` : ''}
                  {can('edit') && (
                    <button className="ml-2 text-accent underline-offset-2 hover:underline" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                  )}
                </p>
              </>
            )}

            <section>
              <h3 className="mb-1 font-semibold">Sources</h3>
              {r.sources.length ? (
                <ul className="space-y-1">
                  {r.sources.map((s) => (
                    <li key={s.url} className="flex flex-wrap items-center gap-2">
                      <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="max-w-full truncate text-accent hover:underline">
                        {s.title || s.publisher}
                      </a>
                      <Badge>{s.tier}</Badge>
                      <span className="text-xs text-muted">
                        {s.reachable === false ? 'unreachable' : s.reachable ? (s.supports === false ? 'does not mention the subject' : 'reachable, mentions the subject') : 'not checked'} · checked {fmt(s.checkedAt)}
                      </span>
                      {can('edit') && r.sources.length > 0 && (
                        <button className="text-xs text-muted hover:text-danger" onClick={() => void run({ action: 'kcUpdate', removeSources: [s.url] })} aria-label={`Remove source ${s.publisher}`}>
                          remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No sources.</p>
              )}
            </section>

            {r.assessment && (
              <section>
                <h3 className="mb-1 font-semibold">Assessment ({r.assessment.by === 'ai' ? 'AI-assisted, advisory' : 'rules only'})</h3>
                <p>
                  {r.assessment.verdict.replace(/_/g, ' ')} · {Math.round(r.assessment.score * 100)}%
                </p>
                {r.assessment.reasons.length > 0 && <ul className="mt-1 list-disc pl-5 text-muted">{r.assessment.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
                {r.assessment.uncertainties.length > 0 && (
                  <>
                    <p className="mt-2 text-xs font-medium">Uncertainties</p>
                    <ul className="list-disc pl-5 text-muted">{r.assessment.uncertainties.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </>
                )}
              </section>
            )}

            {data.duplicate && (
              <section className="rounded-xl border border-border p-3">
                <h3 className="mb-1 font-semibold">Similar record</h3>
                <button className="text-accent hover:underline" onClick={() => onOpen(data.duplicate!.id)}>
                  {data.duplicate.title}
                </button>{' '}
                <Badge tone={STATUS_TONE[data.duplicate.status]}>{STATUS_LABEL[data.duplicate.status]}</Badge>
                <p className="mt-1 line-clamp-3 text-muted">{data.duplicate.content}</p>
                {can('edit') && (
                  <Button size="sm" variant="ghost" className="mt-2" icon={<Merge className="size-4" />} disabled={busy} onClick={() => void run({ action: 'kcMerge', targetId: data.duplicate!.id, sourceId: r.id })}>
                    Merge this record into it
                  </Button>
                )}
              </section>
            )}

            {can('review') && r.status === 'PENDING' && (
              <div>
                <Label htmlFor="kc-reason">Reason if rejecting (optional)</Label>
                <Input id="kc-reason" value={rejectReason} maxLength={300} onChange={(e) => setRejectReason(e.target.value)} />
              </div>
            )}
            {can('edit') && !data.duplicate && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label htmlFor="kc-merge" hint="Paste another record's id to fold this one into it">
                    Merge into
                  </Label>
                  <Input id="kc-merge" value={mergeId} onChange={(e) => setMergeId(e.target.value.trim())} placeholder="record id" />
                </div>
                <Button variant="ghost" disabled={busy || !/^[A-Za-z0-9_-]{6,40}$/.test(mergeId)} onClick={() => void run({ action: 'kcMerge', targetId: mergeId, sourceId: r.id })}>
                  Merge
                </Button>
              </div>
            )}

            <section>
              <h3 className="mb-1 font-semibold">Provenance</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted">Id</dt>
                <dd className="font-mono">{r.id}</dd>
                <dt className="text-muted">Origin</dt>
                <dd>{r.origin === 'admin' ? 'Written by an administrator' : r.origin === 'url' ? 'Extracted from a web page by an administrator' : 'Discovered from a credible source in a web search (no conversation text)'}</dd>
                <dt className="text-muted">Created</dt>
                <dd>
                  {fmt(r.createdAt)} by {r.createdBy === 'system' ? 'the maintenance job' : r.createdBy}
                </dd>
                <dt className="text-muted">Verified</dt>
                <dd>{r.verifiedAt ? `${fmt(r.verifiedAt)} by ${r.verifiedBy}` : '–'}</dd>
                <dt className="text-muted">Next review</dt>
                <dd>{fmt(r.reviewAt)}</dd>
                <dt className="text-muted">Version</dt>
                <dd>
                  {r.version}
                  {r.mergedFrom.length ? ` · merged from ${r.mergedFrom.join(', ')}` : ''}
                </dd>
                <dt className="text-muted">Search</dt>
                <dd>{r.hasVector ? 'keyword and meaning' : 'keyword'}</dd>
                {r.rejectedReason && (
                  <>
                    <dt className="text-muted">Rejected because</dt>
                    <dd>{r.rejectedReason}</dd>
                  </>
                )}
              </dl>
            </section>

            {data.audit.length > 0 && (
              <section>
                <h3 className="mb-1 font-semibold">History</h3>
                <ul className="space-y-1 text-xs text-muted">
                  {data.audit.map((a) => (
                    <li key={a.id}>
                      {fmt(a.at)} · {a.action.replace(/_/g, ' ')} · {a.actorEmail ?? 'system'} {a.detail ? `· ${a.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )
      )}
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete this record permanently?"
        message="It is removed from the repository for good. Archiving keeps it out of answers and can be undone."
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          if (await run({ action: 'kcDelete', confirm: true })) onClose();
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'ack'}
        onClose={() => setConfirm(null)}
        title="Approve despite the warning?"
        message="This record may duplicate or contradict verified knowledge. Approve only if you compared them and it is correct."
        confirmLabel="Approve"
        danger={false}
        onConfirm={async () => {
          await run({ action: 'kcStatus', to: 'approve', acknowledge: true });
          setConfirm(null);
        }}
      />
    </Dialog>
  );
}

/* ------------------------------ create ------------------------------ */

function CreateDialog({ mode, categories, onClose, onCreated }: { mode: 'manual' | 'url'; categories: Category[]; onClose: () => void; onCreated: (id: string | null) => void }) {
  const [form, setForm] = useState({ title: '', content: '', sources: '', tags: '', categoryId: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'url') {
        const r = await kc<{ created: string[]; skipped: string[] }>({ action: 'kcDiscoverUrl', url: form.url.trim(), categoryId: form.categoryId || null });
        if (!r.created.length) setMsg(`No new candidates. ${r.skipped.join(' ')}`);
        else onCreated(r.created.length === 1 ? r.created[0] : null);
      } else {
        const r = await kc<{ ok: boolean; id?: string; messages?: string[]; existingId?: string }>({
          action: 'kcSubmit',
          title: form.title,
          content: form.content,
          sources: form.sources.split(/\s+/).map((s) => s.trim()).filter(Boolean),
          tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
          categoryId: form.categoryId || null,
        });
        if (r.ok && r.id) onCreated(r.id);
        else setMsg(r.messages?.join(' ') ?? 'Not saved.');
      }
    } catch (e) {
      setMsg(errText(e, 'Could not submit.'));
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === 'url' ? /^https:\/\/\S+$/.test(form.url.trim()) : form.title.trim().length >= 3 && form.content.trim().length >= 20;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={mode === 'url' ? 'Propose knowledge from a web page' : 'New knowledge record'}
      description="Everything is screened for personal data and checked against its sources, then waits in the review queue. Nothing is used in answers until it is approved."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready || busy}>
            {busy ? 'Checking…' : mode === 'url' ? 'Read page' : 'Submit for review'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {msg && <p className="text-danger">{msg}</p>}
        {mode === 'url' ? (
          <div>
            <Label htmlFor="kc-url" hint="A public https page from a credible publisher. Up to five facts are proposed; one free AI call.">
              Page address
            </Label>
            <Input id="kc-url" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" />
          </div>
        ) : (
          <>
            <div>
              <Label htmlFor="kc-ntitle">Title</Label>
              <Input id="kc-ntitle" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="kc-ncontent" hint="Self-contained, neutral, no personal details.">
                Content
              </Label>
              <Textarea id="kc-ncontent" rows={6} value={form.content} maxLength={4000} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="kc-nsources" hint="Up to five https addresses, separated by spaces or lines.">
                Sources
              </Label>
              <Textarea id="kc-nsources" rows={2} value={form.sources} onChange={(e) => setForm({ ...form, sources: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="kc-ntags">Tags (comma separated)</Label>
              <Input id="kc-ntags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            </div>
          </>
        )}
        <div>
          <Label>Category</Label>
          <Select value={form.categoryId} onChange={(v) => setForm({ ...form, categoryId: v })} options={[{ value: '', label: 'Suggest automatically / none' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------ categories ------------------------------ */

function CategoriesTab({ categories, can, superAdmin, onChanged }: { categories: Category[]; can: (p: Perm) => boolean; superAdmin: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string; reviewDays: string } | null>(null);
  const [removing, setRemoving] = useState<Category | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const manage = can('categories');

  const save = async () => {
    if (!edit) return;
    try {
      await kc({ action: 'kcCategorySave', ...(edit.id ? { id: edit.id } : {}), name: edit.name, description: edit.description, ...(superAdmin ? { reviewDays: edit.reviewDays ? Number(edit.reviewDays) : null } : {}) });
      setEdit(null);
      setMsg(null);
      onChanged();
    } catch (e) {
      setMsg(errText(e, 'Not saved.'));
    }
  };

  return (
    <>
      {manage && (
        <div className="mb-3 flex justify-end">
          <Button size="sm" icon={<FilePlus2 className="size-4" />} onClick={() => setEdit({ name: '', description: '', reviewDays: '' })}>
            New category
          </Button>
        </div>
      )}
      {msg && <p className="mb-2 text-sm text-danger">{msg}</p>}
      {categories.length === 0 ? (
        <EmptyState icon={<BookCheck className="size-6" />} title="No categories yet">
          Create categories to organise knowledge (for example Ghana government, Health, Technology).
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-muted">
                  {c.count} record{c.count === 1 ? '' : 's'}
                  {c.description ? ` · ${c.description}` : ''}
                  {c.reviewDays ? ` · review every ${c.reviewDays} days` : ''}
                </div>
              </div>
              {manage && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ id: c.id, name: c.name, description: c.description, reviewDays: c.reviewDays ? String(c.reviewDays) : '' })}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (setRemoving(c), setMoveTo(''))}>
                    Delete or merge
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <Dialog
          open
          onClose={() => setEdit(null)}
          title={edit.id ? 'Edit category' : 'New category'}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={edit.name.trim().length < 2}>
                Save
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            <div>
              <Label htmlFor="cat-name">Name</Label>
              <Input id="cat-name" value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="cat-desc">Description</Label>
              <Input id="cat-desc" value={edit.description} maxLength={300} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </div>
            {superAdmin && (
              <div>
                <Label htmlFor="cat-days" hint="Empty: the default review period">
                  Review every (days)
                </Label>
                <Input id="cat-days" type="number" min={7} max={3650} value={edit.reviewDays} onChange={(e) => setEdit({ ...edit, reviewDays: e.target.value })} />
              </div>
            )}
          </div>
        </Dialog>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.name ?? ''}”?`}
        message={
          <div className="space-y-2">
            <p>Its {removing?.count ?? 0} records are kept and moved to the category you choose (or left uncategorised).</p>
            <Select value={moveTo} onChange={setMoveTo} options={[{ value: '', label: 'Leave uncategorised' }, ...categories.filter((c) => c.id !== removing?.id).map((c) => ({ value: c.id, label: `Merge into ${c.name}` }))]} />
          </div>
        }
        confirmLabel={moveTo ? 'Merge' : 'Delete category'}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await kc(moveTo ? { action: 'kcCategoryMerge', fromId: removing.id, intoId: moveTo } : { action: 'kcCategoryDelete', id: removing.id, moveTo: null, confirm: true });
            onChanged();
          } catch (e) {
            setMsg(errText(e, 'Not removed.'));
          }
          setRemoving(null);
        }}
      />
    </>
  );
}

/* ------------------------------ intelligence ------------------------------ */

interface Intel {
  frequentTopics: { terms: string[]; count: number; misses: number; covered: number }[];
  gaps: { terms: string[]; count: number; misses: number }[];
  duplicates: { a: string; b: string; titleA: string; titleB: string; similarity: number }[];
  conflicts: { a: string; b: string; titleA: string; titleB: string; similarity: number }[];
  outdated: { id: string; title: string; reviewAt: number | null; unreachable: number }[];
  lowConfidence: { id: string; title: string; confidence: number }[];
  emptyCategories: { id: string; name: string }[];
  topicInsightsEnabled: boolean;
}

function IntelligenceTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [d, setD] = useState<Intel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    kc<Intel>({ action: 'kcIntelligence' }).then(setD, (e) => setErr(errText(e, 'Could not load.')));
  }, []);
  if (err) return <p className="text-sm text-danger">{err}</p>;
  if (!d)
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted">
        <Spinner className="size-4" /> Analysing
      </div>
    );
  const Pair = ({ p }: { p: Intel['duplicates'][number] }) => (
    <li className="px-4 py-2">
      <button className="text-accent hover:underline" onClick={() => onOpen(p.a)}>
        {p.titleA}
      </button>{' '}
      ↔{' '}
      <button className="text-accent hover:underline" onClick={() => onOpen(p.b)}>
        {p.titleB}
      </button>
      <span className="ml-2 text-xs text-muted">{Math.round(p.similarity * 100)}% similar</span>
    </li>
  );
  const Block = ({ title, empty, children, count }: { title: string; empty: string; children: ReactNode; count: number }) => (
    <section>
      <h2 className="mb-2 text-sm font-semibold">
        {title} <span className="font-normal text-muted">({count})</span>
      </h2>
      {count ? <ul className="divide-y divide-border rounded-2xl border border-border text-sm">{children}</ul> : <p className="text-sm text-muted">{empty}</p>}
    </section>
  );
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Block title="Knowledge gaps" count={d.gaps.length} empty={d.topicInsightsEnabled ? 'No frequent unanswered topics.' : 'Topic insights are off (Settings). Gaps need aggregated question topics.'}>
        {d.gaps.map((g) => (
          <li key={g.terms.join(' ')} className="flex justify-between px-4 py-2">
            <span>{g.terms.join(' · ')}</span>
            <span className="text-xs text-muted">{g.misses} of {g.count} not covered</span>
          </li>
        ))}
      </Block>
      <Block title="Frequent topics" count={d.frequentTopics.length} empty={d.topicInsightsEnabled ? 'No topics recorded yet.' : 'Topic insights are off.'}>
        {d.frequentTopics.slice(0, 15).map((g) => (
          <li key={g.terms.join(' ')} className="flex justify-between px-4 py-2">
            <span>{g.terms.join(' · ')}</span>
            <span className="text-xs text-muted">{g.count} questions</span>
          </li>
        ))}
      </Block>
      <Block title="Possible contradictions" count={d.conflicts.length} empty="No verified records give different figures for the same subject.">
        {d.conflicts.map((p) => <Pair key={p.a + p.b} p={p} />)}
      </Block>
      <Block title="Possible duplicates" count={d.duplicates.length} empty="No near-identical records.">
        {d.duplicates.map((p) => <Pair key={p.a + p.b} p={p} />)}
      </Block>
      <Block title="Outdated or unreachable" count={d.outdated.length} empty="Every verified record is within its review period and reachable.">
        {d.outdated.map((o) => (
          <li key={o.id} className="flex justify-between gap-2 px-4 py-2">
            <button className="truncate text-left text-accent hover:underline" onClick={() => onOpen(o.id)}>
              {o.title}
            </button>
            <span className="shrink-0 text-xs text-muted">{o.unreachable ? `${o.unreachable} source(s) unreachable` : `review was due ${fmt(o.reviewAt)}`}</span>
          </li>
        ))}
      </Block>
      <Block title="Verified with low confidence" count={d.lowConfidence.length} empty="None below 50%.">
        {d.lowConfidence.map((o) => (
          <li key={o.id} className="flex justify-between gap-2 px-4 py-2">
            <button className="truncate text-left text-accent hover:underline" onClick={() => onOpen(o.id)}>
              {o.title}
            </button>
            <span className="text-xs text-muted">{Math.round(o.confidence * 100)}%</span>
          </li>
        ))}
      </Block>
    </div>
  );
}

/* ------------------------------ activity ------------------------------ */

function ActivityTab() {
  const [rows, setRows] = useState<{ id: string; at: number; action: string; actorEmail: string | null; recordId: string | null; detail: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    kc<{ entries: NonNullable<typeof rows> }>({ action: 'kcAudit', limit: 200 }).then((d) => setRows(d.entries), (e) => setErr(errText(e, 'Could not load.')));
  }, []);
  if (err) return <p className="text-sm text-danger">{err}</p>;
  if (!rows) return <Spinner className="size-4" />;
  if (!rows.length)
    return (
      <EmptyState icon={<BookCheck className="size-6" />} title="No activity yet">
        Every change to knowledge, categories and settings is recorded here.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border text-sm">
      {rows.map((a) => (
        <li key={a.id} className="px-4 py-2">
          <span className="font-medium">{a.action.replace(/_/g, ' ')}</span> <span className="text-muted">· {a.actorEmail ?? 'system'} · {fmt(a.at)}</span>
          {a.detail && <div className="text-xs text-muted">{a.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------ settings (super admin) ------------------------------ */

function SettingsTab({ onChanged }: { onChanged: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  useEffect(() => {
    kc<{ settings: Settings }>({ action: 'kcSettings' }).then((d) => setS(d.settings), (e) => setMsg(errText(e, 'Could not load.')));
  }, []);
  const save = async (patch: Partial<Settings>) => {
    setMsg(null);
    try {
      const d = await kc<{ settings: Settings }>({ action: 'kcSettingsSave', settings: patch });
      setS(d.settings);
      setMsg('Saved.');
      onChanged();
    } catch (e) {
      setMsg(errText(e, 'Not saved.'));
    }
  };
  if (!s) return msg ? <p className="text-sm text-danger">{msg}</p> : <Spinner className="size-4" />;
  const togglePerm = (em: string, p: Perm) => {
    const cur = s.admins[em] ?? [];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    const admins = { ...s.admins };
    if (next.length) admins[em] = next;
    else delete admins[em];
    void save({ admins });
  };
  return (
    <div className="space-y-8 text-sm">
      {msg && <p className="text-muted" role="status">{msg}</p>}
      <section className="space-y-3">
        <h2 className="font-semibold">Use in answers</h2>
        <label className="flex items-center justify-between gap-4">
          <span className="font-medium">Answers may use verified knowledge</span>
          <Switch checked={s.retrievalEnabled} label="Answers may use verified knowledge" onChange={(v) => void save({ retrievalEnabled: v })} />
        </label>
        <p className="text-xs text-muted">Only verified records are ever used. Turning this off stops their use immediately on this server and within minutes everywhere.</p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Review policy</h2>
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="kc-days">Re-review verified records every (days)</Label>
            <Input id="kc-days" type="number" min={7} max={3650} defaultValue={s.reviewDays} onBlur={(e) => Number(e.target.value) !== s.reviewDays && void save({ reviewDays: Number(e.target.value) })} className="w-32" />
          </div>
        </div>
        <p className="text-xs text-muted">Records past their review date are flagged and their sources re-checked by the daily job. Nothing is deleted or unpublished automatically. Categories can have their own period.</p>
        <div>
          <Label htmlFor="kc-cap" hint="Each is one call to a free AI model">
            Automatic reviews per day
          </Label>
          <Input id="kc-cap" type="number" min={0} max={2000} defaultValue={s.assessmentsDailyCap} onBlur={(e) => Number(e.target.value) !== s.assessmentsDailyCap && void save({ assessmentsDailyCap: Number(e.target.value) })} className="w-32" />
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Discovery and insights (off by default)</h2>
        <label className="flex items-center justify-between gap-4">
          <span className="font-medium">Propose knowledge from credible sources found by web searches</span>
          <Switch checked={s.discoveryFromWebSearch} label="Propose knowledge from credible sources found by web searches" onChange={(v) => void save({ discoveryFromWebSearch: v })} />
        </label>
        <p className="text-xs text-muted">Only the public address of official, wire and specialist sources is queued, never the question or conversation. The daily job reads up to {s.discoveryDailyCap} pages and places proposals in the review queue.</p>
        <label className="flex items-center justify-between gap-4">
          <span className="font-medium">Count anonymous question topics for gap analysis</span>
          <Switch checked={s.topicInsights} label="Count anonymous question topics for gap analysis" onChange={(v) => void save({ topicInsights: v })} />
        </label>
        <p className="text-xs text-muted">
          Keeps three keywords and a count per topic: no question text, no user, nothing from questions that contain personal details. Before enabling, make sure your Privacy Policy describes this aggregated use.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Knowledge administrators</h2>
        <p className="text-xs text-muted">Platform administrators always have full control. Add people by the verified email of their Atlas AI account and choose what they may do.</p>
        {Object.keys(s.admins).length === 0 && <p className="text-muted">None yet.</p>}
        {Object.entries(s.admins).map(([em, perms]) => (
          <div key={em} className="rounded-xl border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{em}</span>
              <Button size="sm" variant="ghost" onClick={() => { const a = { ...s.admins }; delete a[em]; void save({ admins: a }); }}>
                Remove
              </Button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {PERMS.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={perms.includes(p)} disabled={p === 'view'} onChange={() => togglePerm(em, p)} />
                  {PERM_LABEL[p]}
                </label>
              ))}
            </div>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const em = email.trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return;
            void save({ admins: { ...s.admins, [em]: ['view', 'review'] } }).then(() => setEmail(''));
          }}
        >
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label="Email of a new knowledge administrator" />
          <Button type="submit" variant="ghost">
            Add
          </Button>
        </form>
      </section>
    </div>
  );
}
