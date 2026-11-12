import { ChevronDown, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Page } from '../shell/Page';
import { ACTION_GROUPS, ACTION_LABELS, fmt, type LogEntry } from './auditLog';

function Changes({ changes }: { changes: NonNullable<LogEntry['changes']> }) {
  const show = (v: unknown) => JSON.stringify(v, null, 2);
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {(['before', 'after'] as const).map((k) => (
        <div key={k} className="min-w-0">
          <div className="mb-1 text-[11px] font-medium text-subtle uppercase">{k === 'before' ? 'Before' : 'After'}</div>
          <pre className="scroll-thin max-h-56 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">{show(changes[k])}</pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Every administrator action, newest first. Entries are written only by the server and cannot be
 * changed or deleted from the app (Firestore rules deny all client writes to adminLogs).
 */
export default function AuditLogsPage() {
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    api<{ logs: LogEntry[] }>('admin', { json: { action: 'logs' } })
      .then((r) => {
        setLogs(r.logs);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'The audit log could not be loaded.'))
      .finally(() => setBusy(false));
  }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const m = ACTION_GROUPS.find((g) => g.id === group)?.match ?? (() => true);
    const needle = q.trim().toLowerCase();
    return (logs ?? []).filter(
      (l) => m(l.action) && (!needle || `${l.adminEmail} ${l.targetEmail} ${l.detail} ${ACTION_LABELS[l.action] ?? l.action}`.toLowerCase().includes(needle)),
    );
  }, [logs, group, q]);

  return (
    <Page title="Audit Logs" wide>
      <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Audit Logs</h1>
      <p className="mb-5 max-w-2xl text-sm text-muted">
        The latest 100 administrator actions, with who made each change, when, and the values before and after where recorded. Entries are written by the server and cannot be edited or
        deleted.
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={group} onChange={setGroup} className="h-9 w-full sm:w-56" aria-label="Filter by type" options={ACTION_GROUPS.map((g) => ({ value: g.id, label: g.label }))} />
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input className="h-9 pl-9" placeholder="Search admin, account or detail" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the audit log" />
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={busy} onClick={load}>
          Refresh
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !logs ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !shown.length ? (
        <p className="py-10 text-center text-sm text-subtle">{logs.length ? 'No entries match.' : 'No administrator actions recorded yet.'}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {shown.map((l) => (
            <li key={l.id} className="px-3 py-3 sm:px-4">
              <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <div className="text-sm sm:text-[15px]">
                    {ACTION_LABELS[l.action] ?? l.action}
                    <span className="hidden text-muted sm:inline"> · </span>
                    <span className="block text-muted [overflow-wrap:anywhere] sm:inline sm:text-fg">{l.targetEmail ?? 'unknown account'}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">
                    by {l.adminEmail ?? 'the system'}
                    {l.detail ? ` · ${l.detail}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <time className="text-xs text-muted tabular-nums">{fmt(l.at, true)}</time>
                  {l.changes && (
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-accent hover:bg-surface-2"
                      aria-expanded={open === l.id}
                      onClick={() => setOpen(open === l.id ? null : l.id)}
                    >
                      Changes <ChevronDown className={cn('size-3.5 transition-transform', open === l.id && 'rotate-180')} />
                    </button>
                  )}
                </div>
              </div>
              {open === l.id && l.changes && <Changes changes={l.changes} />}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
