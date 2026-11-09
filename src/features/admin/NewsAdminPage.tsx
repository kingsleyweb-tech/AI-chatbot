import { Newspaper, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, EmptyState, Input, Label, Select, Spinner, Switch } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { Page } from '../shell/Page';

type Tier = 'official' | 'wire' | 'specialist' | 'regional' | 'social' | 'unknown';
const TOPICS = ['general', 'ai', 'tech', 'security', 'space', 'science', 'politics', 'business', 'health', 'sports'] as const;

interface FeedHealth {
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string | null;
  lastItems?: number;
  lastMs?: number;
  reads?: number;
  failures?: number;
}

interface Feed {
  id: string;
  name: string;
  url: string;
  domain: string;
  tier: Tier;
  topics: string[];
  regions: string[];
  entities?: string[];
  disabled?: string | null;
  builtIn: boolean;
  health: FeedHealth | null;
}

type Day = Record<string, unknown> & { day: string };

interface View {
  days: Day[];
  feeds: Feed[];
  generatedAt: number;
}

const BUILT_IN_HINT = 'Built-in feeds can be switched off but not removed.';
const fmt = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={hint}>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </div>
  );
}

/** Totals over the loaded days, read only from recorded counters. */
function totals(days: Day[]) {
  const keys = ['requests', 'discovered', 'inWindow', 'rejectedOld', 'undated', 'redated', 'duplicates', 'irrelevant', 'stories', 'expanded', 'failures'] as const;
  const t = Object.fromEntries(keys.map((k) => [k, 0])) as Record<(typeof keys)[number], number>;
  const sources: Record<string, { ok: number; empty: number; failed: number; cached: number; ms: number; timed: number }> = {};
  for (const d of days) {
    for (const k of keys) t[k] += n(d[k]);
    const src = (d.sources ?? {}) as Record<string, Record<string, unknown>>;
    for (const [id, v] of Object.entries(src)) {
      const s = (sources[id] ??= { ok: 0, empty: 0, failed: 0, cached: 0, ms: 0, timed: 0 });
      s.ok += n(v.ok);
      s.empty += n(v.empty);
      s.failed += n(v.failed);
      s.cached += n(v.cached);
      s.ms += n(v.ms);
      s.timed += n(v.timed);
    }
  }
  return { t, sources };
}

function FeedStatus({ feed }: { feed: Feed }) {
  if (feed.disabled) return <Badge>Off</Badge>;
  const h = feed.health;
  if (!h || (!h.lastOkAt && !h.lastErrorAt)) return <Badge>Not read yet</Badge>;
  if ((h.lastErrorAt ?? 0) > (h.lastOkAt ?? 0)) return <Badge tone="danger">Failing</Badge>;
  return <Badge tone="accent">Working</Badge>;
}

export default function NewsAdminPage() {
  const { admin } = useAuth();
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'failing' | 'off'>('all');
  const [removing, setRemoving] = useState<Feed | null>(null);
  const [form, setForm] = useState({ id: '', name: '', url: '', tier: 'unknown' as Tier, topic: 'general' as (typeof TOPICS)[number], regions: 'world' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<View>('admin', { json: { action: 'news', days: 7 } }));
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'failed', message: err instanceof ApiError ? err.message : 'News monitoring could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  const act = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await api('admin', { json: body });
      setNotice(done);
      await load();
      return true;
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'The change could not be saved.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sum = useMemo(() => totals(data?.days ?? []), [data]);
  const feeds = useMemo(() => {
    const all = data?.feeds ?? [];
    if (filter === 'off') return all.filter((f) => f.disabled);
    if (filter === 'failing') return all.filter((f) => !f.disabled && f.health && (f.health.lastErrorAt ?? 0) > (f.health.lastOkAt ?? 0));
    return all;
  }, [data, filter]);

  if (!admin) return <Navigate to="/settings" replace />;
  const refresh = (
    <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
      Refresh
    </Button>
  );
  const { t, sources } = sum;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const idOk = /^[a-z0-9_]{2,40}$/.test(form.id);
  const urlOk = /^https:\/\/\S+$/.test(form.url);

  return (
    <Page title="News sources" back="/settings" wide actions={refresh}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">News sources</h1>
          {refresh}
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<Newspaper className="size-6" />} title="News monitoring could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !data ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading news monitoring
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">Last {data.days.length ? `${data.days.length} day${data.days.length === 1 ? '' : 's'} with activity` : '7 days'}. Counts are recorded as questions are answered; nothing is estimated.</p>
            <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4">
              <Stat label="News questions" value={t.requests} />
              <Stat label="Stories delivered" value={t.stories} />
              <Stat label="Articles checked" value={t.discovered} />
              <Stat label="Inside the time window" value={pct(t.inWindow, t.discovered)} hint={`${t.inWindow} of ${t.discovered}`} />
              <Stat label="Rejected as too old" value={t.rejectedOld} />
              <Stat label="Re-dated old articles caught" value={t.redated} hint="An old article shown with a new date by a search engine or feed" />
              <Stat label="Undated (never shown as current)" value={t.undated} />
              <Stat label="Duplicates merged" value={t.duplicates} />
              <Stat label="Off-topic dropped" value={t.irrelevant} />
              <Stat label="Window widened" value={t.expanded} hint="Too few recent stories; the wider window was disclosed to the user" />
              <Stat label="Nothing retrieved" value={t.failures} />
              <Stat label="Feeds" value={`${data.feeds.filter((f) => !f.disabled).length} on`} hint={`${data.feeds.length} in total`} />
            </div>

            <h2 className="mb-2 text-sm font-semibold">Retrieval sources</h2>
            {Object.keys(sources).length === 0 ? (
              <p className="mb-6 text-sm text-muted">No news questions recorded yet.</p>
            ) : (
              <div className="mb-6 overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 font-medium">Source</th>
                      <th className="px-4 py-2 font-medium">Answered</th>
                      <th className="px-4 py-2 font-medium">Empty</th>
                      <th className="px-4 py-2 font-medium">Failed</th>
                      <th className="px-4 py-2 font-medium">From cache</th>
                      <th className="px-4 py-2 font-medium">Avg. time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(sources).map(([id, s]) => (
                      <tr key={id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 font-medium">{id === 'rss' ? 'Publisher feeds' : id === 'serpapi' ? 'SerpAPI' : id === 'tavily' ? 'Tavily' : id}</td>
                        <td className="px-4 py-2 tabular-nums">{s.ok}</td>
                        <td className="px-4 py-2 tabular-nums">{s.empty}</td>
                        <td className={cn('px-4 py-2 tabular-nums', s.failed > 0 && 'text-danger')}>{s.failed}</td>
                        <td className="px-4 py-2 tabular-nums">{id === 'rss' ? '–' : s.cached}</td>
                        <td className="px-4 py-2 tabular-nums">{s.timed ? `${Math.round(s.ms / s.timed)} ms` : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Publisher feeds</h2>
              <Select
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All feeds' },
                  { value: 'failing', label: 'Failing' },
                  { value: 'off', label: 'Switched off' },
                ]}
              />
            </div>
            {notice && <p className="mb-2 text-sm text-muted" role="status">{notice}</p>}
            <div className="mb-8 divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {feeds.length === 0 && <p className="px-4 py-6 text-sm text-muted">No feeds match.</p>}
              {feeds.map((f) => {
                const custom = !f.builtIn;
                return (
                  <div key={f.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{f.name}</span>
                        <FeedStatus feed={f} />
                        <Badge>{f.tier}</Badge>
                        {custom && <Badge tone="warn">Added</Badge>}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {f.domain} · {f.topics.join(', ')} · {f.regions.join(', ')}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {f.disabled
                          ? f.disabled
                          : f.health
                            ? `Last read ${fmt(f.health.lastOkAt)}${f.health.lastItems != null ? ` · ${f.health.lastItems} entries` : ''}${f.health.lastMs != null ? ` · ${f.health.lastMs} ms` : ''}${f.health.lastError ? ` · last error ${fmt(f.health.lastErrorAt)}: ${f.health.lastError}` : ''}${f.health.reads ? ` · ${f.health.failures ?? 0}/${f.health.reads} reads failed` : ''}`
                            : 'Read when a question needs it.'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={!f.disabled}
                        label={`${f.disabled ? 'Switch on' : 'Switch off'} ${f.name}`}
                        disabled={busy === f.id}
                        onChange={(on) => void act(f.id, on ? { action: 'newsFeedEnable', id: f.id } : { action: 'newsFeedDisable', id: f.id }, on ? `${f.name} switched on.` : `${f.name} switched off.`)}
                      />
                      {custom ? (
                        <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setRemoving(f)} aria-label={`Remove ${f.name}`} />
                      ) : (
                        <span className="sr-only">{BUILT_IN_HINT}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <h2 className="mb-2 text-sm font-semibold">Add a feed</h2>
            <form
              className="mb-10 grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!idOk || !urlOk || !form.name.trim()) return;
                void act(
                  'add',
                  {
                    action: 'newsFeedAdd',
                    feed: { id: form.id, name: form.name.trim(), url: form.url.trim(), tier: form.tier, topics: [form.topic], regions: form.regions.split(/[\s,]+/).filter(Boolean).slice(0, 6) },
                  },
                  `${form.name.trim()} added. It is read the next time a matching question is asked.`,
                ).then((ok) => ok && setForm((f) => ({ ...f, id: '', name: '', url: '' })));
              }}
            >
              <div>
                <Label htmlFor="feed-name">Name</Label>
                <Input id="feed-name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ghana News Agency" />
              </div>
              <div>
                <Label htmlFor="feed-id" hint="Lowercase letters, digits and _">Short id</Label>
                <Input id="feed-id" value={form.id} maxLength={40} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="gna" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="feed-url" hint="RSS or Atom address, https only">Feed address</Label>
                <Input id="feed-url" type="url" value={form.url} maxLength={500} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/feed/" />
              </div>
              <div>
                <Label>Credibility</Label>
                <Select
                  value={form.tier}
                  onChange={(v) => setForm({ ...form, tier: v })}
                  options={[
                    { value: 'official', label: 'Official source' },
                    { value: 'wire', label: 'Wire service / major outlet' },
                    { value: 'specialist', label: 'Specialist publication' },
                    { value: 'regional', label: 'Regional outlet' },
                    { value: 'unknown', label: 'Not assessed' },
                  ]}
                />
              </div>
              <div>
                <Label>Topic</Label>
                <Select value={form.topic} onChange={(v) => setForm({ ...form, topic: v })} options={TOPICS.map((x) => ({ value: x, label: x }))} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="feed-regions" hint="e.g. world, ghana, west_africa, africa, europe, usa, asia">Regions</Label>
                <Input id="feed-regions" value={form.regions} onChange={(e) => setForm({ ...form, regions: e.target.value.toLowerCase() })} />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" icon={<Plus className="size-4" />} disabled={!idOk || !urlOk || !form.name.trim() || busy === 'add'}>
                  Add feed
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Remove this feed?"
        message={removing ? `${removing.name} will no longer be read. Its health history is kept.` : ''}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removing) await act(removing.id, { action: 'newsFeedRemove', id: removing.id }, `${removing.name} removed.`);
          setRemoving(null);
        }}
      />
    </Page>
  );
}
