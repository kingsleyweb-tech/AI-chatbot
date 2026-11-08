import { ChevronRight, LifeBuoy, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { categoryLabel, type SupportReportView } from '@shared/support';
import { Page } from '../shell/Page';
import { supportApi } from './api';
import { errorText, fmtDate, StatusBadge } from './parts';

export default function MyReportsPage() {
  const [rows, setRows] = useState<SupportReportView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await supportApi.mine()).reports);
    } catch (err) {
      setError(errorText(err, 'Your reports could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const refresh = (
    <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
      Refresh
    </Button>
  );

  return (
    <Page title="My reports" back="/settings" actions={refresh}>
      <div className="mx-auto max-w-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="hidden text-xl font-semibold tracking-tight lg:block">My reports</h1>
          <div className="ml-auto flex gap-2">
            <span className="hidden lg:block">{refresh}</span>
            <Link to="/support/new">
              <Button size="sm" icon={<Plus className="size-4" />}>
                Report an issue
              </Button>
            </Link>
          </div>
        </div>

        {error ? (
          <EmptyState icon={<LifeBuoy className="size-6" />} title="Reports could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error}
          </EmptyState>
        ) : !rows ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading your reports
          </div>
        ) : !rows.length ? (
          <EmptyState icon={<LifeBuoy className="size-6" />} title="No reports yet" action={<Link to="/support/new"><Button>Report an issue</Button></Link>}>
            If something isn’t working, or you have an idea, send a report and follow the replies here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-elevated">
            {rows.map((r) => (
              <li key={r.ref}>
                <Link to={`/support/${r.ref}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 truncate text-[15px] font-medium">{r.title}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      <span className="font-mono">{r.ref}</span> · {categoryLabel(r.category)} · {fmtDate(r.createdAt, false)}
                    </div>
                    {r.lastAdminReply && (
                      <p className="mt-1.5 line-clamp-2 text-sm text-fg/85">
                        <span className="font-medium">Atlas Support:</span> {r.lastAdminReply.text}
                      </p>
                    )}
                    <div className="mt-1 text-xs text-subtle">Updated {fmtDate(r.updatedAt)}</div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}
