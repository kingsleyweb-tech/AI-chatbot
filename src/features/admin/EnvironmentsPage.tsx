import { AlertTriangle, CheckCircle2, History, Layers, Power, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, Dialog, EmptyState, Input, Label, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import {
  ENV_LABEL,
  ENV_PROVIDERS,
  ENVIRONMENTS,
  PROVIDER_LABEL,
  SUPPORTED_ENVIRONMENTS,
  type CredentialView,
  type EnvId,
  type EnvironmentConfig,
  type EnvironmentUsageRow,
  type EnvProvider,
  type HealthResult,
} from '../../../server/shared/environments';
import { Page } from '../shell/Page';

/** Mirrors environmentStatus() in server/environments/admin.ts. Never contains credentials. */
interface Status {
  config: EnvironmentConfig;
  overall: EnvId | 'mixed';
  credentials: CredentialView[];
  usage: {
    rows: EnvironmentUsageRow[];
    temporary: { today: number; week: number; refusedToday: number; refusedWeek: number; day: string; isoWeek: string };
    cloudflareNeuronsToday: Record<EnvId, number>;
  };
  history: { id: string; action: string; adminEmail: string | null; detail: string; providers: EnvProvider[]; result: 'success' | 'refused'; previous: string | null; next: string | null; at: string | number }[];
  generatedAt: number;
}

type Pending =
  | { kind: 'global'; environment: EnvId }
  | { kind: 'provider'; provider: EnvProvider; environment: EnvId }
  | { kind: 'disable'; provider: EnvProvider; environment: EnvId; disabled: boolean };

const STALE_MS = 6 * 60 * 60_000;
const when = (v: string | number | null | undefined) =>
  v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const n = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toLocaleString());

function envTone(e: EnvId | 'mixed'): 'neutral' | 'accent' | 'warn' {
  return e === 'main' ? 'accent' : e === 'mixed' || e === 'temporary' ? 'warn' : 'neutral';
}

function HealthBadge({ h, configured }: { h: HealthResult | null; configured: boolean }) {
  if (!configured) return <Badge>Not set</Badge>;
  if (!h) return <Badge>Not checked</Badge>;
  if (h.ok) return <Badge tone="accent">Healthy</Badge>;
  return <Badge tone="danger">{h.status === 'invalid' ? 'Invalid' : h.status === 'missing' ? 'Missing' : 'Error'}</Badge>;
}

function Meter({ used, max }: { used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * API Environment Manager (Super Admin): which credential set each AI and search provider uses,
 * health checks, emergency switch-offs, the Temporary ceiling, usage per environment and the
 * change history. ElevenLabs is not managed here: it is one shared integration in every environment.
 */
export default function EnvironmentsPage() {
  const { admin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [ceiling, setCeiling] = useState({ daily: '', weekly: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api<Status>('admin', { json: { action: 'environments', op: { op: 'status' } } });
      setData(r);
      setCeiling({ daily: String(r.config.temporaryCeiling.daily), weekly: String(r.config.temporaryCeiling.weekly) });
      return r;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The API environments could not be loaded.');
      return null;
    }
  }, []);

  const runHealth = useCallback(
    async (provider?: EnvProvider, environment?: EnvId) => {
      setChecking(provider ? `${provider}_${environment ?? ''}` : 'all');
      try {
        await api('admin', { json: { action: 'environments', op: { op: 'health', provider, environment } } });
        await load();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'The check could not be run.', 'error');
      } finally {
        setChecking(null);
      }
    },
    [load, toast],
  );

  useEffect(() => {
    if (!admin) return;
    void load().then((r) => {
      // checks cost no provider quota: refresh results that are missing or older than 6 hours
      if (r && r.credentials.some((c) => c.configured && (!c.health || Date.now() - c.health.checkedAt > STALE_MS))) void runHealth();
    });
  }, [admin, load, runHealth]);

  if (!admin) return <Navigate to="/settings" replace />;

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setProblems([]);
    try {
      const op =
        pending.kind === 'disable'
          ? { op: 'disable', provider: pending.provider, environment: pending.environment, disabled: pending.disabled, confirm: true, reason: reason || undefined }
          : { op: 'switch', scope: pending.kind, provider: pending.kind === 'provider' ? pending.provider : undefined, environment: pending.environment, confirm: true, reason: reason || undefined };
      await api('admin', { json: { action: 'environments', op } });
      toast(pending.kind === 'disable' ? 'Saved.' : 'Switched. New requests use the new environment; requests already running finish unchanged.', 'success');
      setPending(null);
      setReason('');
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        const list = (err.details?.problems as string[] | undefined) ?? [err.message];
        setProblems(list);
      } else setProblems(['The change could not be saved.']);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveCeiling = async () => {
    const daily = Number(ceiling.daily);
    const weekly = Number(ceiling.weekly);
    if (!Number.isInteger(daily) || !Number.isInteger(weekly) || daily < 0 || weekly < 0) {
      toast('Enter whole numbers (0 or more).', 'error');
      return;
    }
    setBusy(true);
    try {
      await api('admin', { json: { action: 'environments', op: { op: 'ceiling', daily, weekly } } });
      toast('Ceiling saved.', 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The ceiling could not be saved.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const cred = (p: EnvProvider, e: EnvId) => data?.credentials.find((c) => c.provider === p && c.environment === e);
  const describePending = (p: Pending): string => {
    if (p.kind === 'global')
      return `Switch every provider to ${ENV_LABEL[p.environment]}. ${
        p.environment === 'secondary' ? 'OpenRouter, Tavily and SerpAPI have no Secondary credentials, so they use Main. ' : ''
      }User usage limits will follow the ${ENV_LABEL[p.environment]} environment.`;
    if (p.kind === 'provider') return `Switch ${PROVIDER_LABEL[p.provider]} to ${ENV_LABEL[p.environment]}.`;
    return `${p.disabled ? 'Switch off' : 'Switch back on'} ${PROVIDER_LABEL[p.provider]} ${ENV_LABEL[p.environment]}.${
      p.disabled && data?.config.providers[p.provider] === p.environment
        ? ` It is in use now: ${PROVIDER_LABEL[p.provider]} becomes unavailable (it is never moved to other credentials automatically).`
        : ''
    }`;
  };

  return (
    <Page title="API Environments" wide>
      <div className="mb-6 hidden lg:block">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Layers className="size-6" aria-hidden="true" /> API Environment Manager
        </h1>
        <p className="mt-1 text-sm text-muted">
          Which credentials each provider uses. Keys never leave the server: this page shows variable names and health only.
        </p>
      </div>

      {error ? (
        <EmptyState icon={<ShieldAlert className="size-6" />} title="Not available">{error}</EmptyState>
      ) : !data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ---------------- overview ---------------- */}
          <section className="rounded-2xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Active environment</div>
                <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
                  {data.overall === 'mixed' ? 'Mixed configuration' : ENV_LABEL[data.overall]}
                  <Badge tone={envTone(data.overall)}>{data.overall === 'mixed' ? 'Mixed' : 'All providers'}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted">
                  User usage limits: {ENV_LABEL[data.config.global]} · version {data.config.version} · changed {when(data.config.updatedAt)}
                  {data.config.updatedBy ? ` by ${data.config.updatedBy}` : ''}
                </div>
              </div>
              <Button variant="outline" size="sm" icon={<RefreshCw className="size-4" />} loading={checking === 'all'} onClick={() => void runHealth()}>
                Check all credentials
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {ENVIRONMENTS.map((e) => (
                <Button
                  key={e}
                  variant={data.overall === e ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={data.overall === e}
                  onClick={() => {
                    setProblems([]);
                    setPending({ kind: 'global', environment: e });
                  }}
                >
                  Use {ENV_LABEL[e]} everywhere
                </Button>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              ElevenLabs (voice) is one shared integration and is not affected by any environment switch.
            </p>
          </section>

          {/* ---------------- providers ---------------- */}
          <section>
            <h2 className="mb-2 text-base font-semibold">Providers</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {ENV_PROVIDERS.map((p) => {
                const active = data.config.providers[p];
                return (
                  <div key={p} className="rounded-2xl border border-border p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold">{PROVIDER_LABEL[p]}</div>
                      <Badge tone={envTone(active)}>Using {ENV_LABEL[active]}</Badge>
                    </div>
                    {SUPPORTED_ENVIRONMENTS[p].length < 3 && (
                      <p className="mt-1 text-xs text-muted">Has Main and Temporary credentials only (no Secondary set).</p>
                    )}
                    <ul className="mt-3 space-y-3">
                      {SUPPORTED_ENVIRONMENTS[p].map((e) => {
                        const c = cred(p, e);
                        if (!c) return null;
                        const key = `${p}_${e}`;
                        return (
                          <li key={e} className={cn('rounded-xl border px-3 py-2', active === e ? 'border-accent' : 'border-border')}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2 text-sm font-medium">
                                {ENV_LABEL[e]}
                                <HealthBadge h={c.health} configured={c.configured} />
                                {c.disabled && <Badge tone="danger">Switched off</Badge>}
                              </div>
                              <div className="flex gap-1">
                                <Button size="sm" variant="ghost" loading={checking === key} disabled={!c.configured} onClick={() => void runHealth(p, e)}>
                                  Check
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon={<Power className="size-3.5" />}
                                  onClick={() => {
                                    setProblems([]);
                                    setPending({ kind: 'disable', provider: p, environment: e, disabled: !c.disabled });
                                  }}
                                >
                                  {c.disabled ? 'Turn on' : 'Turn off'}
                                </Button>
                                {active !== e && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setProblems([]);
                                      setPending({ kind: 'provider', provider: p, environment: e });
                                    }}
                                  >
                                    Use
                                  </Button>
                                )}
                              </div>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                              {c.variables.map((v) => (
                                <span key={v.name} className="inline-flex items-center gap-1 font-mono">
                                  {v.set ? <CheckCircle2 className="size-3 text-accent" aria-label="set" /> : <XCircle className="size-3 text-danger" aria-label="not set" />}
                                  {v.name}
                                </span>
                              ))}
                            </div>
                            {c.health && (
                              <p className={cn('mt-1 text-xs', c.health.ok ? 'text-muted' : 'text-danger')}>
                                {c.health.detail} <span className="text-muted">({when(c.health.checkedAt)}, {c.health.ms} ms)</span>
                              </p>
                            )}
                            {c.sharedWith.length > 0 && (
                              <p className="mt-1 flex items-center gap-1 text-xs text-warn">
                                <AlertTriangle className="size-3.5" aria-hidden="true" /> Same credentials as {c.sharedWith.map((x) => ENV_LABEL[x]).join(', ')}: no separate capacity.
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---------------- temporary ceiling ---------------- */}
          <section className="rounded-2xl border border-border p-4">
            <h2 className="text-base font-semibold">Temporary environment ceiling</h2>
            <p className="mt-1 text-xs text-muted">
              Provider requests on Temporary credentials, all providers together (counted before each request is sent). When a ceiling is
              reached, Temporary requests are refused with a clear message; Main and Secondary are never affected and nothing moves to other
              credentials.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="flex justify-between text-sm">
                  <span>Today ({data.usage.temporary.day} UTC)</span>
                  <span className="tabular-nums">
                    {n(data.usage.temporary.today)} / {n(data.config.temporaryCeiling.daily)}
                  </span>
                </div>
                <Meter used={data.usage.temporary.today} max={data.config.temporaryCeiling.daily} />
                {data.usage.temporary.refusedToday > 0 && <p className="mt-1 text-xs text-danger">{n(data.usage.temporary.refusedToday)} refused today</p>}
              </div>
              <div>
                <div className="flex justify-between text-sm">
                  <span>This week ({data.usage.temporary.isoWeek})</span>
                  <span className="tabular-nums">
                    {n(data.usage.temporary.week)} / {n(data.config.temporaryCeiling.weekly)}
                  </span>
                </div>
                <Meter used={data.usage.temporary.week} max={data.config.temporaryCeiling.weekly} />
                {data.usage.temporary.refusedWeek > 0 && <p className="mt-1 text-xs text-danger">{n(data.usage.temporary.refusedWeek)} refused this week</p>}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="ceil-d">Daily ceiling</Label>
                <Input id="ceil-d" inputMode="numeric" className="w-32" value={ceiling.daily} onChange={(e) => setCeiling((c) => ({ ...c, daily: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="ceil-w">Weekly ceiling</Label>
                <Input id="ceil-w" inputMode="numeric" className="w-32" value={ceiling.weekly} onChange={(e) => setCeiling((c) => ({ ...c, weekly: e.target.value }))} />
              </div>
              <Button variant="primary" size="md" loading={busy && !pending} onClick={() => void saveCeiling()}>
                Save ceiling
              </Button>
            </div>
          </section>

          {/* ---------------- usage ---------------- */}
          <section className="rounded-2xl border border-border p-4">
            <h2 className="text-base font-semibold">Usage by environment</h2>
            <p className="mt-1 text-xs text-muted">
              Requests counted by Atlas AI (app estimate, UTC periods). Provider-confirmed figures come from each provider’s own account
              endpoint at the last check, and from Cloudflare’s per-request Neuron figure.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-2 font-medium">Provider</th>
                    <th className="py-1 pr-2 font-medium">Environment</th>
                    <th className="py-1 pr-2 text-right font-medium">Today</th>
                    <th className="py-1 pr-2 text-right font-medium">Week</th>
                    <th className="py-1 pr-2 text-right font-medium">Month</th>
                    <th className="py-1 font-medium">Provider-confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.rows.map((r) => {
                    const acct = cred(r.provider, r.environment)?.health?.account;
                    const confirmed =
                      r.provider === 'cloudflare'
                        ? `${n(data.usage.cloudflareNeuronsToday[r.environment])} Neurons today`
                        : r.provider === 'openrouter' && acct
                          ? `credits used ${n(acct.creditsUsed as number | null)}${acct.freeRequestsLeftToday != null ? ` · free requests left today ${n(acct.freeRequestsLeftToday as number)}` : ''}`
                          : (r.provider === 'tavily' || r.provider === 'serpapi') && acct
                            ? `${n(acct.usedThisMonth as number | null)} / ${n(acct.monthlyLimit as number | null)} this month`
                            : r.provider === 'gemini'
                              ? 'Not reported by Google'
                              : '–';
                    return (
                      <tr key={`${r.provider}_${r.environment}`} className={cn('border-t border-border', data.config.providers[r.provider] === r.environment && 'font-medium')}>
                        <td className="py-1.5 pr-2">{PROVIDER_LABEL[r.provider]}</td>
                        <td className="py-1.5 pr-2">{ENV_LABEL[r.environment]}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{n(r.today)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{n(r.week)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{n(r.month)}</td>
                        <td className="py-1.5 text-xs text-muted">{confirmed}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---------------- history ---------------- */}
          <section className="rounded-2xl border border-border p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <History className="size-4" aria-hidden="true" /> Change history
            </h2>
            {data.history.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No changes yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {data.history.map((h) => (
                  <li key={h.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={h.result === 'success' ? 'accent' : 'danger'}>{h.result === 'success' ? 'Done' : 'Refused'}</Badge>
                      <span className="text-muted">{when(h.at)}</span>
                      <span className="text-muted">{h.adminEmail ?? ''}</span>
                    </div>
                    <p className="mt-0.5">{h.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <Dialog
        open={pending !== null}
        onClose={() => !busy && setPending(null)}
        title={pending?.kind === 'disable' ? (pending.disabled ? 'Switch off credentials?' : 'Switch credentials back on?') : 'Switch API environment?'}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={pending?.kind === 'disable' && pending.disabled ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()}>
              Confirm
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-3 text-sm">
            <p>{describePending(pending)}</p>
            {pending.kind !== 'disable' && (
              <p className="text-xs text-muted">
                The credentials are health-checked first; nothing changes if any is missing or fails. Requests already running finish with
                the environment they started with.
              </p>
            )}
            <div>
              <Label htmlFor="env-reason">Reason (optional, kept in the audit log)</Label>
              <Textarea id="env-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {problems.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-danger/10 p-2 text-xs text-danger">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Dialog>
    </Page>
  );
}
