import { limit, orderBy, query } from 'firebase/firestore';
import {
  AlertCircle,
  ExternalLink,
  FileText,
  FolderPlus,
  Globe,
  Library,
  Loader2,
  Lock,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, IconButton, Input, Label, Menu, PageHeader, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { paths } from '@/lib/db';
import { DOC_ACCEPT } from '@/lib/extract';
import { useQuery } from '@/lib/hooks';
import type { KbCollection, KbScope, KbSourceMeta, Source, UsageDay } from '@/lib/types';
import { cn, domainOf, formatBytes, relativeTime } from '@/lib/utils';
import { useAuth, useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import {
  addFile,
  addUrl,
  createCollection,
  deleteCollection,
  deleteSource,
  isDue,
  kbPaths,
  refreshSource,
  renameCollection,
  saveNote,
  searchKnowledge,
  setAiAllowed,
  SUGGESTED_COLLECTIONS,
  validateFile,
} from './kb';

const ALL = '__all';
const REFRESH_OPTIONS = [
  { value: '0', label: 'Only when I refresh it' },
  { value: '7', label: 'Every week (when you open this page)' },
  { value: '30', label: 'Every month (when you open this page)' },
  { value: '90', label: 'Every 3 months (when you open this page)' },
];
// due web pages are refreshed at most once per browser session, a few at a time
const autoRefreshed = new Set<string>();

function errMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export default function KnowledgePage() {
  const uid = useUid();
  const { admin } = useAuth();
  const toast = useToast();
  const [scope, setScope] = useState<KbScope>('personal');
  const canEdit = scope === 'personal' || admin;
  const cols = useQuery<KbCollection>(query(kbPaths.collections(scope, uid), orderBy('createdAt', 'asc'), limit(200)), [uid, scope]);
  const srcs = useQuery<KbSourceMeta>(query(kbPaths.sources(scope, uid), orderBy('createdAt', 'desc'), limit(500)), [uid, scope]);
  const usage = useQuery<UsageDay>(query(paths.usage(uid), orderBy('date', 'desc'), limit(30)), [uid]);

  const [selected, setSelected] = useState<string>(ALL);
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<null | 'collection' | 'upload' | 'url' | 'note'>(null);
  const [editingCol, setEditingCol] = useState<KbCollection | null>(null);
  const [editingNote, setEditingNote] = useState<KbSourceMeta | null>(null);
  const [toDelete, setToDelete] = useState<KbSourceMeta | null>(null);
  const [colToDelete, setColToDelete] = useState<KbCollection | null>(null);
  const [aiToggle, setAiToggle] = useState<KbSourceMeta | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<KbSourceMeta | null>(null);

  useEffect(() => setSelected(ALL), [scope]);
  const names = useMemo(() => new Map(cols.data.map((c) => [c.id, c.name])), [cols.data]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of srcs.data) m.set(s.collectionId, (m.get(s.collectionId) ?? 0) + 1);
    return m;
  }, [srcs.data]);
  const visible = srcs.data.filter(
    (s) => (selected === ALL || s.collectionId === selected) && (!filter || `${s.title} ${s.url ?? ''}`.toLowerCase().includes(filter.toLowerCase())),
  );

  const run = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy((b) => new Set(b).add(id));
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (err) {
      toast(errMessage(err, 'Something went wrong.'), 'error');
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
    }
  };

  // Scheduled refresh without a background server: due web pages refresh when this page is opened.
  useEffect(() => {
    if (!canEdit || srcs.loading) return;
    const due = srcs.data.filter((s) => isDue(s) && !autoRefreshed.has(`${scope}/${s.id}`)).slice(0, 3);
    if (!due.length) return;
    due.forEach((s) => autoRefreshed.add(`${scope}/${s.id}`));
    void (async () => {
      let changed = 0;
      for (const s of due) {
        const r = await refreshSource(scope, s.id).catch(() => null);
        if (r && !r.unchanged) changed++;
      }
      toast(`Checked ${due.length} web page${due.length > 1 ? 's' : ''} due for refresh${changed ? `; ${changed} updated` : ''}.`, 'success');
    })();
  }, [canEdit, scope, srcs.loading, srcs.data, toast]);

  const stats = useMemo(() => {
    const d = srcs.data;
    const times = d.map((s) => s.refreshedAt ?? s.indexedAt).filter(Boolean) as string[];
    const k = usage.data.reduce(
      (a, u) => ({ r: a.r + (u.knowledge?.retrievals ?? 0), u: a.u + (u.knowledge?.used ?? 0), h: a.h + (u.knowledge?.hits ?? 0) }),
      { r: 0, u: 0, h: 0 },
    );
    return {
      sources: d.length,
      files: d.filter((s) => s.type === 'file').length,
      pages: d.filter((s) => s.type === 'url').length,
      notes: d.filter((s) => s.type === 'note').length,
      chunks: d.reduce((n, s) => n + (s.chunkCount ?? 0), 0),
      text: d.reduce((n, s) => n + (s.charCount ?? 0), 0),
      processing: d.filter((s) => s.status === 'processing').length,
      failed: d.filter((s) => s.status === 'failed').length,
      due: d.filter((s) => isDue(s)).length,
      last: times.sort().pop(),
      usage: k,
    };
  }, [srcs.data, usage.data]);

  const needCollection = canEdit && !cols.loading && cols.data.length === 0;
  const defaultCollection = selected !== ALL ? selected : (cols.data[0]?.id ?? '');

  const addMenu = (
    <Menu
      trigger={(p) => (
        <Button {...p} variant="primary" icon={<Plus className="size-4" />} disabled={!cols.data.length}>
          Add source
        </Button>
      )}
      items={[
        { label: 'Upload files', icon: <Upload className="size-4" />, onSelect: () => setDialog('upload') },
        { label: 'Add a web page', icon: <Globe className="size-4" />, onSelect: () => setDialog('url') },
        {
          label: 'Write a note',
          icon: <NotebookPen className="size-4" />,
          onSelect: () => {
            setEditingNote(null);
            setDialog('note');
          },
        },
      ]}
    />
  );

  return (
    <Page title="Knowledge base" wide>
      <PageHeader
        title="Knowledge base"
        description="Documents, web pages and notes Atlas AI searches before answering. Answers cite them as [K1], [K2]…"
        actions={
          canEdit ? (
            <>
              <Button
                variant="outline"
                icon={<FolderPlus className="size-4" />}
                onClick={() => {
                  setEditingCol(null);
                  setDialog('collection');
                }}
              >
                <span className="hidden sm:inline">New collection</span>
              </Button>
              {addMenu}
            </>
          ) : undefined
        }
      />

      <div className="mb-5 inline-flex rounded-[10px] border border-border p-0.5 text-sm" role="tablist">
        {(['personal', 'shared'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={scope === s}
            onClick={() => setScope(s)}
            className={cn('rounded-lg px-3 py-1.5 transition-colors', scope === s ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-fg')}
          >
            {s === 'personal' ? 'Personal' : 'Shared'}
          </button>
        ))}
      </div>
      {scope === 'shared' && (
        <p className="-mt-3 mb-5 text-xs text-muted">
          Shared collections are visible to everyone with access to this app{admin ? '. You can manage them as an administrator.' : ' and managed by administrators.'}
        </p>
      )}

      <Stats stats={stats} loading={srcs.loading} />

      <KnowledgeSearch />

      {needCollection ? (
        <EmptyState icon={<Library className="size-5" />} title="Start with a collection">
          Collections group related sources, such as companies, research or personal notes.
          <span className="mt-4 flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              onClick={() =>
                run('suggested', async () => {
                  for (const n of SUGGESTED_COLLECTIONS) await createCollection(scope, uid, n);
                })
              }
              loading={busy.has('suggested')}
            >
              Create suggested collections
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEditingCol(null);
                setDialog('collection');
              }}
            >
              Create my own
            </Button>
          </span>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Collections" className="min-w-0 lg:sticky lg:top-4 lg:self-start">
            <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
              <CollectionItem label="All sources" count={srcs.data.length} active={selected === ALL} onClick={() => setSelected(ALL)} />
              {cols.data.map((c) => (
                <CollectionItem
                  key={c.id}
                  label={c.name}
                  count={counts.get(c.id) ?? 0}
                  active={selected === c.id}
                  onClick={() => setSelected(c.id)}
                  menu={
                    canEdit
                      ? [
                          {
                            label: 'Rename',
                            icon: <Pencil className="size-4" />,
                            onSelect: () => {
                              setEditingCol(c);
                              setDialog('collection');
                            },
                          },
                          { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setColToDelete(c) },
                        ]
                      : undefined
                  }
                />
              ))}
            </ul>
          </nav>

          <section className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sources by name" className="pl-9" />
              </div>
            </div>
            {srcs.loading ? (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            ) : !visible.length ? (
              <EmptyState icon={<FileText className="size-5" />} title={filter ? 'No matching sources' : 'No sources yet'}>
                {canEdit ? 'Upload files, add a web page or write a note.' : 'Nothing has been shared here yet.'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {visible.map((s) => (
                  <SourceRow
                    key={s.id}
                    s={s}
                    collection={selected === ALL ? names.get(s.collectionId) : undefined}
                    busy={busy.has(s.id) || s.status === 'processing'}
                    canEdit={canEdit}
                    onRefresh={() => run(s.id, () => refreshSource(scope, s.id), s.type === 'url' ? 'Page refreshed.' : 'Re-indexed.')}
                    onRefreshTavily={() => run(s.id, () => refreshSource(scope, s.id, true), 'Page read with Tavily.')}
                    onReplace={() => {
                      setReplacing(s);
                      replaceInput.current?.click();
                    }}
                    onEditNote={() => {
                      setEditingNote(s);
                      setDialog('note');
                    }}
                    onToggleAi={() => setAiToggle(s)}
                    onDelete={() => setToDelete(s)}
                  />
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-subtle">
              Files are read on your device; only their text is stored. Confidential sources are searched by keyword only and are never sent to an AI provider
              unless you allow it. Adding sources gives Atlas AI material to look up; it does not retrain the AI model.
            </p>
          </section>
        </div>
      )}

      <input
        ref={replaceInput}
        type="file"
        accept={DOC_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          const s = replacing;
          if (!f || !s) return;
          void run(s.id, () => addFile(scope, uid, f, { collectionId: s.collectionId, confidential: Boolean(s.confidential), replaceId: s.id }), 'Replacing content…');
        }}
      />

      <CollectionDialog
        open={dialog === 'collection'}
        editing={editingCol}
        onClose={() => setDialog(null)}
        onSave={async (name, description) => {
          if (editingCol) await renameCollection(scope, uid, editingCol.id, name, description);
          else setSelected(await createCollection(scope, uid, name, description));
        }}
      />
      <UploadDialog
        open={dialog === 'upload'}
        onClose={() => setDialog(null)}
        collections={cols.data}
        initial={defaultCollection}
        onUpload={async (files, collectionId, confidential) => {
          for (const f of files) {
            try {
              await addFile(scope, uid, f, { collectionId, confidential });
            } catch (err) {
              toast(errMessage(err, 'Upload failed.'), 'error');
            }
          }
        }}
      />
      <UrlDialog
        open={dialog === 'url'}
        onClose={() => setDialog(null)}
        collections={cols.data}
        initial={defaultCollection}
        onAdd={async (a) => {
          const r = await addUrl(scope, a);
          toast(r.existed ? (r.unchanged ? 'Already in your knowledge base; no changes.' : 'Page updated.') : `Page added (${r.chunkCount} sections).`, 'success');
        }}
      />
      <NoteDialog
        open={dialog === 'note'}
        onClose={() => setDialog(null)}
        collections={cols.data}
        initial={editingNote?.collectionId ?? defaultCollection}
        editing={editingNote}
        onSave={async (a) => {
          await saveNote(scope, uid, { ...a, id: editingNote?.id });
          toast(editingNote ? 'Note updated.' : 'Note added.', 'success');
        }}
      />
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete source?"
        message={`“${toDelete?.title}” and its index will be removed. It will no longer be used in answers.`}
        onConfirm={async () => {
          if (toDelete) await run(toDelete.id, () => deleteSource(scope, toDelete.id), 'Source deleted.');
        }}
      />
      <ConfirmDialog
        open={Boolean(colToDelete)}
        onClose={() => setColToDelete(null)}
        title="Delete collection?"
        message={`“${colToDelete?.name}” and its ${counts.get(colToDelete?.id ?? '') ?? 0} source(s) will be removed permanently.`}
        onConfirm={async () => {
          if (!colToDelete) return;
          await run(colToDelete.id, () => deleteCollection(scope, uid, colToDelete.id), 'Collection deleted.');
          setSelected(ALL);
        }}
      />
      <ConfirmDialog
        open={Boolean(aiToggle)}
        onClose={() => setAiToggle(null)}
        title={aiToggle?.aiAllowed ? 'Stop AI access?' : 'Allow AI access?'}
        message={
          aiToggle?.aiAllowed
            ? `“${aiToggle?.title}” will go back to keyword-only indexing and will not be sent to the AI provider.`
            : `Text from “${aiToggle?.title}” will be sent to the AI provider (Google Gemini or OpenRouter) to create embeddings and to answer questions. Only allow this if the document may leave your device.`
        }
        onConfirm={async () => {
          const s = aiToggle;
          if (s) await run(s.id, () => setAiAllowed(scope, uid, s.id, !s.aiAllowed), s.aiAllowed ? 'AI access removed.' : 'AI access allowed.');
        }}
      />
    </Page>
  );
}

function Stats({
  stats,
  loading,
}: {
  stats: {
    sources: number;
    files: number;
    pages: number;
    notes: number;
    chunks: number;
    text: number;
    processing: number;
    failed: number;
    due: number;
    last?: string;
    usage: { r: number; u: number; h: number };
  };
  loading: boolean;
}) {
  if (loading) return null;
  const items: [string, string, string?][] = [
    ['Sources', String(stats.sources), `${stats.files} files · ${stats.pages} web pages · ${stats.notes} notes`],
    ['Indexed sections', stats.chunks.toLocaleString(), `${formatBytes(stats.text)} of text`],
    ['Status', stats.failed ? `${stats.failed} failed` : stats.processing ? `${stats.processing} processing` : 'All ready', stats.due ? `${stats.due} page(s) due for refresh` : stats.processing && stats.failed ? `${stats.processing} processing` : undefined],
    ['Last updated', stats.last ? relativeTime(stats.last) : '—'],
    ['Used in answers', `${stats.usage.u}`, `of ${stats.usage.r} lookups in 30 days`],
  ];
  return (
    <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-4 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([k, v, sub]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle">{k}</dt>
          <dd className={cn('mt-0.5 text-[15px] font-semibold', k === 'Status' && stats.failed > 0 && 'text-danger')}>{v}</dd>
          {sub && <dd className="truncate text-xs text-muted">{sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

function KnowledgeSearch() {
  const [q, setQ] = useState('');
  const [state, setState] = useState<{ loading: boolean; results: Source[] | null; error?: string; strong?: boolean }>({ loading: false, results: null });
  const submit = async () => {
    if (!q.trim()) return;
    setState({ loading: true, results: null });
    try {
      const r = await searchKnowledge(q.trim());
      setState({ loading: false, results: r.results, strong: r.strong });
    } catch (err) {
      setState({ loading: false, results: null, error: errMessage(err, 'Search failed.') });
    }
  };
  return (
    <div className="mb-6">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything you can access, e.g. “Soko Aerial services”" />
        <Button type="submit" variant="outline" loading={state.loading} icon={<Search className="size-4" />}>
          Search
        </Button>
      </form>
      {state.error && <p className="mt-2 text-sm text-danger">{state.error}</p>}
      {state.results && (
        <div className="mt-3">
          {!state.results.length ? (
            <p className="text-sm text-muted">Nothing relevant found in the knowledge base.</p>
          ) : (
            <ol className="space-y-2.5">
              {state.results.map((r) => (
                <li key={r.index} className="text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{r.title}</span>
                    <span className="text-xs text-subtle">{r.site}</span>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">
                        {domainOf(r.url)}
                      </a>
                    )}
                  </div>
                  <p className="line-clamp-2 text-muted">{r.snippet}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function CollectionItem({
  label,
  count,
  active,
  onClick,
  menu,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  menu?: { label: string; icon: React.ReactNode; danger?: boolean; onSelect: () => void }[];
}) {
  return (
    <li className="group flex shrink-0 items-center">
      <button
        onClick={onClick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
          active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )}
      >
        <span className="truncate">{label}</span>
        <span className="ml-auto text-xs tabular-nums text-subtle">{count}</span>
      </button>
      {menu && (
        <Menu
          trigger={(p) => (
            <IconButton {...p} label={`${label} options`} size="sm" className="lg:opacity-0 lg:group-hover:opacity-100">
              <MoreHorizontal className="size-4" />
            </IconButton>
          )}
          items={menu}
        />
      )}
    </li>
  );
}

function SourceRow({
  s,
  collection,
  busy,
  canEdit,
  onRefresh,
  onRefreshTavily,
  onReplace,
  onEditNote,
  onToggleAi,
  onDelete,
}: {
  s: KbSourceMeta;
  collection?: string;
  busy: boolean;
  canEdit: boolean;
  onRefresh: () => void;
  onRefreshTavily: () => void;
  onReplace: () => void;
  onEditNote: () => void;
  onToggleAi: () => void;
  onDelete: () => void;
}) {
  const Icon = s.type === 'url' ? Globe : s.type === 'note' ? NotebookPen : FileText;
  const when = s.refreshedAt ?? s.indexedAt;
  const items = [
    ...(s.url ? [{ label: 'Open page', icon: <ExternalLink className="size-4" />, onSelect: () => window.open(s.url, '_blank', 'noopener') }] : []),
    ...(canEdit
      ? [
          ...(s.type === 'url'
            ? [
                { label: 'Refresh now', icon: <RefreshCw className="size-4" />, onSelect: onRefresh, disabled: busy },
                { label: 'Read with Tavily (1 credit)', icon: <Globe className="size-4" />, onSelect: onRefreshTavily, disabled: busy, hint: 'For pages that block direct reading' },
              ]
            : s.type === 'file'
              ? [
                  { label: 'Replace file…', icon: <Upload className="size-4" />, onSelect: onReplace, disabled: busy },
                  { label: 'Re-index', icon: <RefreshCw className="size-4" />, onSelect: onRefresh, disabled: busy || s.status === 'failed' },
                ]
              : [{ label: 'Edit note', icon: <Pencil className="size-4" />, onSelect: onEditNote, disabled: busy }]),
          ...(s.confidential
            ? [
                {
                  label: s.aiAllowed ? 'Stop AI access' : 'Allow AI access…',
                  icon: s.aiAllowed ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />,
                  onSelect: onToggleAi,
                  disabled: busy,
                },
              ]
            : []),
          'separator' as const,
          { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: onDelete },
        ]
      : []),
  ];
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          s.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent',
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : s.status === 'failed' ? <AlertCircle className="size-4" /> : <Icon className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{s.title}</span>
          {s.confidential && (
            <Badge tone={s.aiAllowed ? 'neutral' : 'warn'} className="shrink-0">
              <Lock className="size-3" />
              {s.aiAllowed ? 'Confidential · AI allowed' : 'Confidential'}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          {collection && <span className="hidden sm:inline">{collection} ·</span>}
          {s.status === 'processing' && <span>Reading and indexing…</span>}
          {s.status === 'failed' && <span className="text-danger">{s.error ?? 'Indexing failed'}</span>}
          {s.status === 'ready' && (
            <>
              {s.url ? <span>{domainOf(s.url)}</span> : s.size ? <span>{formatBytes(s.size)}</span> : null}
              <span>· {s.chunkCount ?? 0} sections</span>
              {when && <span title={`Indexed ${s.indexedAt ?? ''}`}>· updated {relativeTime(when)}</span>}
              {s.addedFrom === 'web_search' && <span className="hidden sm:inline">· saved from web search</span>}
            </>
          )}
          {isDue(s) && <Badge tone="accent">Refresh due</Badge>}
        </div>
        {s.warning && <div className="mt-1 text-xs text-warn">{s.warning}</div>}
      </div>
      {items.length > 0 && (
        <Menu
          trigger={(p) => (
            <IconButton {...p} label="Source options" size="sm">
              <MoreHorizontal className="size-4" />
            </IconButton>
          )}
          items={items}
        />
      )}
    </li>
  );
}

function CollectionSelect({ collections, value, onChange }: { collections: KbCollection[]; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label htmlFor="kb-col">Collection</Label>
      <Select id="kb-col" value={value} onChange={onChange} options={collections.map((c) => ({ value: c.id, label: c.name }))} />
    </div>
  );
}

function useSubmit(onClose: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (fn: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(errMessage(err, 'Something went wrong.'));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, submit, setError };
}

function CollectionDialog({
  open,
  editing,
  onClose,
  onSave,
}: {
  open: boolean;
  editing: KbCollection | null;
  onClose: () => void;
  onSave: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { saving, error, submit } = useSubmit(onClose);
  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
    }
  }, [open, editing]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Rename collection' : 'New collection'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={() => submit(() => onSave(name, description))}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="kb-name">Name</Label>
          <Input id="kb-name" value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Companies and Organizations" />
        </div>
        <div>
          <Label htmlFor="kb-desc" hint="Optional">
            Description
          </Label>
          <Input id="kb-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function UploadDialog({
  open,
  onClose,
  collections,
  initial,
  onUpload,
}: {
  open: boolean;
  onClose: () => void;
  collections: KbCollection[];
  initial: string;
  onUpload: (files: File[], collectionId: string, confidential: boolean) => Promise<void>;
}) {
  const [collectionId, setCollectionId] = useState(initial);
  const [confidential, setConfidential] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const { saving, error, submit, setError } = useSubmit(onClose);
  useEffect(() => {
    if (open) {
      setCollectionId(initial);
      setFiles([]);
      setConfidential(false);
      setError(null);
    }
  }, [open, initial, setError]);
  const pick = (list: File[]) => {
    const ok: File[] = [];
    for (const f of list) {
      try {
        validateFile(f);
        ok.push(f);
      } catch (err) {
        setError(errMessage(err, 'Unsupported file.'));
      }
    }
    setFiles((cur) => [...cur, ...ok].slice(0, 20));
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload files"
      description="PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX), CSV, text or Markdown, up to 25 MB each."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!files.length || !collectionId} onClick={() => submit(() => onUpload(files, collectionId, confidential))}>
            Upload {files.length ? `(${files.length})` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <CollectionSelect collections={collections} value={collectionId} onChange={setCollectionId} />
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(Array.from(e.dataTransfer.files));
          }}
          className="flex flex-col items-center rounded-xl border border-dashed border-border-strong px-4 py-6 text-center"
        >
          <Upload className="mb-2 size-5 text-muted" />
          <button onClick={() => input.current?.click()} className="text-sm font-medium text-accent hover:underline">
            Choose files
          </button>
          <span className="mt-0.5 text-xs text-muted">or drop them here</span>
        </div>
        {files.length > 0 && (
          <ul className="max-h-36 space-y-1 overflow-y-auto text-sm">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted" />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto shrink-0 text-xs text-subtle">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-[13px] font-medium">Confidential</span>
            <span className="block text-xs text-muted">Searched by keyword only; never sent to an AI provider unless you allow it later.</span>
          </span>
          <Switch checked={confidential} onChange={setConfidential} label="Confidential" />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept={DOC_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          pick(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </Dialog>
  );
}

function UrlDialog({
  open,
  onClose,
  collections,
  initial,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  collections: KbCollection[];
  initial: string;
  onAdd: (a: { collectionId: string; url: string; refreshDays: number | null; viaTavily: boolean }) => Promise<void>;
}) {
  const [collectionId, setCollectionId] = useState(initial);
  const [url, setUrl] = useState('');
  const [refresh, setRefresh] = useState('0');
  const [viaTavily, setViaTavily] = useState(false);
  const { saving, error, submit, setError } = useSubmit(onClose);
  useEffect(() => {
    if (open) {
      setCollectionId(initial);
      setUrl('');
      setRefresh('0');
      setViaTavily(false);
      setError(null);
    }
  }, [open, initial, setError]);
  const valid = /^https?:\/\/[^\s]+\.[^\s]+/i.test(url.trim());
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a web page"
      description="The page is read once and indexed. Only this page is read; Atlas AI does not crawl the whole site."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!valid || !collectionId}
            onClick={() => submit(() => onAdd({ collectionId, url: url.trim(), refreshDays: Number(refresh) || null, viaTavily }))}
          >
            Add page
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="kb-url">Page address</Label>
          <Input id="kb-url" type="url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/about" />
        </div>
        <CollectionSelect collections={collections} value={collectionId} onChange={setCollectionId} />
        <div>
          <Label htmlFor="kb-refresh">Keep it up to date</Label>
          <Select id="kb-refresh" value={refresh} onChange={setRefresh} options={REFRESH_OPTIONS} />
        </div>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-[13px] font-medium">Use Tavily if the page can't be read directly</span>
            <span className="block text-xs text-muted">Uses 1 Tavily credit, only when needed.</span>
          </span>
          <Switch checked={viaTavily} onChange={setViaTavily} label="Use Tavily if needed" />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function NoteDialog({
  open,
  onClose,
  collections,
  initial,
  editing,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  collections: KbCollection[];
  initial: string;
  editing: KbSourceMeta | null;
  onSave: (a: { collectionId: string; title: string; text: string; confidential: boolean }) => Promise<void>;
}) {
  const [collectionId, setCollectionId] = useState(initial);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [confidential, setConfidential] = useState(false);
  const { saving, error, submit, setError } = useSubmit(onClose);
  useEffect(() => {
    if (open) {
      setCollectionId(initial);
      setTitle(editing?.title ?? '');
      setText(editing?.noteText ?? '');
      setConfidential(Boolean(editing?.confidential));
      setError(null);
    }
  }, [open, initial, editing, setError]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? 'Edit note' : 'Write a note'}
      description="Facts you want Atlas AI to know, such as verified company details. Mark what is verified and what is an assumption."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!text.trim() || !collectionId} onClick={() => submit(() => onSave({ collectionId, title, text, confidential }))}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="kb-title">Title</Label>
          <Input id="kb-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Soko Aerial: company profile" />
        </div>
        {!editing && <CollectionSelect collections={collections} value={collectionId} onChange={setCollectionId} />}
        <div>
          <Label htmlFor="kb-text">Content</Label>
          <Textarea id="kb-text" rows={10} value={text} maxLength={100_000} onChange={(e) => setText(e.target.value)} />
        </div>
        {!editing && (
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-[13px] font-medium">Confidential</span>
              <span className="block text-xs text-muted">Never sent to an AI provider unless you allow it later.</span>
            </span>
            <Switch checked={confidential} onChange={setConfidential} label="Confidential" />
          </label>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
