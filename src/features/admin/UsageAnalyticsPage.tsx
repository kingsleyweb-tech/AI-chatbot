import { useEffect, useMemo, useState } from 'react';
import { Select, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { Page } from '../shell/Page';
import { usageOp, type FeatureId, type FeatureInfo } from './usageAdmin';

interface DayRow {
  day: string;
  [feature: string]: { requests: number; units: number; released: number } | string;
}
type Cell = { requests: number; units: number; released: number };

/** Totals of AI use across all accounts, per day and feature (Atlas AI's own counters). */
export default function UsageAnalyticsPage() {
  const [days, setDays] = useState('14');
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    Promise.all([usageOp<{ days: DayRow[] }>({ op: 'analytics', days: Number(days) }), usageOp<{ features: FeatureInfo[] }>({ op: 'get' })])
      .then(([a, g]) => {
        setRows(a.days);
        setFeatures(g.features);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Analytics could not be loaded.'));
  }, [days]);

  const cell = (r: DayRow, f: FeatureId) => (r[f] as Cell | undefined) ?? { requests: 0, units: 0, released: 0 };
  const totals = useMemo(() => {
    const t = {} as Record<FeatureId, Cell>;
    for (const f of features) t[f.id] = { requests: 0, units: 0, released: 0 };
    for (const r of rows ?? [])
      for (const f of features) {
        const c = cell(r, f.id);
        t[f.id].requests += c.requests;
        t[f.id].units += c.units;
        t[f.id].released += c.released;
      }
    return t;
  }, [rows, features]);
  const peak = Math.max(1, ...features.map((f) => totals[f.id]?.units ?? 0));

  return (
    <Page title="Usage Analytics" wide>
      <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Usage Analytics</h1>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          AI requests counted by Atlas AI across all accounts. Units are allowance units (a Deep Research report counts 3). Requests that failed before producing anything are returned and
          shown as "not charged". Days follow the usage reset time zone.
        </p>
        <Select
          value={days}
          onChange={setDays}
          className="h-9 w-full sm:w-40"
          aria-label="Period"
          options={[
            { value: '7', label: 'Last 7 days' },
            { value: '14', label: 'Last 14 days' },
            { value: '30', label: 'Last 30 days' },
            { value: '60', label: 'Last 60 days' },
          ]}
        />
      </div>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !rows ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !rows.length ? (
        <p className="py-10 text-center text-sm text-subtle">No AI use has been counted yet. Figures appear after the first request with usage limits in place.</p>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-[15px] font-semibold">By feature</h2>
            <ul className="space-y-2.5">
              {features.map((f) => {
                const t = totals[f.id];
                return (
                  <li key={f.id} className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-[9rem_1fr_auto] sm:items-center sm:gap-3">
                    <span className="font-medium sm:truncate sm:font-normal">{f.label}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${(t.units / peak) * 100}%` }} />
                    </div>
                    <span className="text-xs text-muted tabular-nums sm:text-right">
                      {t.requests.toLocaleString()} requests · {t.units.toLocaleString()} units{t.released ? ` · ${t.released} not charged` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          <section>
            <h2 className="mb-3 text-[15px] font-semibold">By day (requests)</h2>
            <div className="scroll-thin overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-subtle">
                    <th className="px-3 py-2 font-medium">Day</th>
                    {features.map((f) => (
                      <th key={f.id} className="px-2 py-2 text-right font-medium">
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.day}>
                      <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{r.day}</td>
                      {features.map((f) => (
                        <td key={f.id} className="px-2 py-1.5 text-right tabular-nums">
                          {cell(r, f.id).requests || <span className="text-subtle">0</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Page>
  );
}
