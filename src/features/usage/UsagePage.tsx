import { Infinity as InfinityIcon, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Page } from '../shell/Page';
import { countdown, refreshUsage, resetText, useUsage, type FeatureView, type UsageState } from './usage';

/** A small clock so the countdowns move without refetching. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Bar({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null) return <div className="h-1.5 w-full rounded-full bg-surface-2" aria-hidden />;
  const pct = limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(used, limit)}
    >
      <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-danger' : pct >= 90 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
    </div>
  );
}

function PeriodCell({ label, p, tz, now }: { label: string; p: FeatureView['daily']; tz: string; now: number }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">
          {p.limit === null ? (
            <span className="text-subtle">{p.used} used · no limit</span>
          ) : (
            <>
              {p.used} / {p.limit}
              <span className="text-subtle"> · {p.remaining} left</span>
            </>
          )}
        </span>
      </div>
      <Bar used={p.used} limit={p.limit} />
      {p.limit !== null && (
        <div className="mt-1 text-[11px] text-subtle" title={`Resets ${resetText(p.resetsAt, tz, now)} (${tz})`}>
          Resets in {countdown(p.resetsAt, now)} · {resetText(p.resetsAt, tz, now)}
        </div>
      )}
    </div>
  );
}

function FeatureRow({ f, tz, now }: { f: FeatureView; tz: string; now: number }) {
  return (
    <li className="py-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{f.label}</div>
          <div className="text-xs text-subtle">{f.explain}</div>
        </div>
        {f.exhausted ? (
          <span className="shrink-0 text-xs font-medium text-danger">Used up</span>
        ) : f.percent !== null ? (
          <span className={cn('shrink-0 text-xs tabular-nums', f.percent >= 90 ? 'text-warn' : 'text-muted')}>{Math.round(f.percent)}% used</span>
        ) : (
          <span className="shrink-0 text-xs text-subtle">No limit</span>
        )}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
        <PeriodCell label="Today" p={f.daily} tz={tz} now={now} />
        <PeriodCell label="This week" p={f.weekly} tz={tz} now={now} />
      </div>
    </li>
  );
}

function History({ s }: { s: UsageState }) {
  const rows = s.history.slice(0, 14);
  if (!rows.length) return <p className="text-sm text-subtle">No AI usage recorded yet.</p>;
  const label = new Map(s.features.map((f) => [f.id as string, f.label]));
  const total = (r: UsageState['history'][number]) => Object.entries(r).reduce((n, [k, v]) => (k === 'day' ? n : n + Number(v)), 0);
  const max = Math.max(1, ...rows.map(total));
  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((r) => (
        <li key={r.day} className="flex items-center gap-3 py-2">
          <span className="w-24 shrink-0 tabular-nums text-muted">{r.day}</span>
          <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <span className="block h-full rounded-full bg-accent/70" style={{ width: `${(total(r) / max) * 100}%` }} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-subtle">
            {Object.entries(r)
              .filter(([k]) => k !== 'day')
              .map(([k, v]) => `${label.get(k) ?? k} ${v}`)
              .join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function UsagePage() {
  const { state, error } = useUsage();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refreshUsage(true);
  }, []);
  const reload = async () => {
    setBusy(true);
    await refreshUsage(true);
    setBusy(false);
  };
  const action = (
    <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', busy && 'animate-spin')} />} onClick={() => void reload()} disabled={busy}>
      Refresh
    </Button>
  );

  return (
    <Page title="AI usage" actions={action}>
      <div className="mx-auto max-w-2xl">
        <div className="mb-1 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">AI usage</h1>
          {action}
        </div>
        {!state ? (
          error ? (
            <p className="py-10 text-sm text-danger">{error}</p>
          ) : (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          )
        ) : (
          <>
            <p className="mb-6 text-sm text-muted">
              {state.unlimited ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-accent">
                  <InfinityIcon className="size-4" /> Unlimited AI Access
                  {state.unlimitedUntil ? <span className="font-normal text-muted">until {resetText(state.unlimitedUntil, state.timezone, now)}</span> : null}
                </span>
              ) : (
                <>
                  Your allowance: <span className="font-medium text-fg">{state.profile.name}</span>.
                </>
              )}{' '}
              Each feature has its own daily and weekly allowance, so using one up never blocks the others. Most requests count as 1; heavier ones
              count a little more. Times are in {state.timezone}.
            </p>
            {state.unlimited && (
              <p className="-mt-3 mb-6 text-xs text-subtle">
                Your usage is still shown below. Shared provider limits can still pause a feature for everyone for a while.
              </p>
            )}
            <ul className="divide-y divide-border border-y border-border">
              {state.features.map((f) => (
                <FeatureRow key={f.id} f={f} tz={state.timezone} now={now} />
              ))}
            </ul>
            <h2 className="mb-2 mt-8 text-sm font-semibold">Recent days</h2>
            <History s={state} />
          </>
        )}
      </div>
    </Page>
  );
}
