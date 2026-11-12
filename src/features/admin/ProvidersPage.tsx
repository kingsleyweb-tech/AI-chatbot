import { Cpu, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, EmptyState, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { Page } from '../shell/Page';

/** Mirrors server/providers/overview.ts. Labels only: never keys, tokens or account ids. */
interface Cooldown {
  model: string | null;
  reason: string;
  until: string;
}
interface GeminiModelRow {
  model: string;
  requestsToday: number;
  ok: number;
  failed: number;
  rateLimited: number;
  rpm: number | null;
  rpmGuard: number | null;
  rpd: number | null;
  remainingToday: number | null;
  limitSource: 'reported' | 'default' | 'unknown';
  lastMinute: number;
  active: number;
}
interface GeminiAccount {
  id: string;
  modelsListed: string[] | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastError: string | null;
  switchedTo: number;
  cooldowns: Cooldown[];
  models: GeminiModelRow[];
}
interface CfAccount {
  id: string;
  neuronsToday: number;
  reservedNow: number;
  remainingUnderCap: number | null;
  requests: number;
  failed: number;
  allowanceUsedUp: boolean;
  usable: boolean;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastError: string | null;
  cooldowns: Cooldown[];
}
interface ProviderEvent {
  id: string;
  provider: string | null;
  account: string | null;
  to: string | null;
  kind: 'cooldown' | 'switch' | 'auth' | null;
  reason: string | null;
  model: string | null;
  until: string | null;
  at: string | null;
}
interface Overview {
  gemini: { day: string; resetsAt: string; accounts: GeminiAccount[] };
  cloudflare: { day: string; resetsAt: string; freeAllowance: number; atlasCap: number | null; accounts: CfAccount[] };
  services?: Services;
  events: ProviderEvent[];
  generatedAt: string;
}

type Src = { source: 'provider' | 'atlas' };
interface SearchPlan extends Src {
  used: number;
  limit: number | null;
  remaining: number | null;
  plan: string | null;
  renews: string | null;
}
interface Services {
  openrouter: {
    configured: boolean;
    freeModelsOnly: boolean;
    freeDailyLimitReached: boolean;
    reported: ({ freeTier: boolean | null; freeDailyRemaining: number | null; creditsRemaining: number | null } & Src) | null;
    note: string;
  };
  tavily: { configured: boolean; plan: SearchPlan | null; caps: ({ daily: number; monthly: number; perUser: boolean } & Src) | null };
  serpapi: { configured: boolean; plan: SearchPlan | null; caps: ({ daily: number; monthly: number; perUser: boolean } & Src) | null };
  elevenlabs: {
    configured: boolean;
    enabled: boolean;
    balance: ({ remainingCredits: number | null; active: boolean } & Src) | null;
    today: { credits: number; requests: number; failed: number } & Src;
    month: { credits: number } & Src;
    caps: ({ appDaily: number; appMonthly: number; perUserDaily: number } & Src) | null;
  };
}

/** Where a figure comes from: the provider's own account endpoint, or Atlas AI's counters and caps. */
function SourceTag({ source }: { source: 'provider' | 'atlas' }) {
  return (
    <span className={cn('ml-1.5 rounded px-1 py-px text-[10px] font-medium', source === 'provider' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}>
      {source === 'provider' ? 'Reported by provider' : 'Atlas counter'}
    </span>
  );
}

function ServiceCard({ title, configured, status, children }: { title: string; configured: boolean; status?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold">{title}</div>
        {configured ? (status ?? <Badge tone="accent">Configured</Badge>) : <Badge>Not configured</Badge>}
      </div>
      {configured && children}
    </section>
  );
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toLocaleString());

function SearchCard({ title, s }: { title: string; s: Services['tavily'] }) {
  return (
    <ServiceCard title={title} configured={s.configured}>
      {s.plan ? (
        <>
          <Row label={<>Plan usage<SourceTag source="provider" /></>}>
            {n(s.plan.used)}
            {s.plan.limit ? ` / ${n(s.plan.limit)}` : ''}
          </Row>
          {s.plan.remaining !== null && <Row label="Left this plan period">{n(s.plan.remaining)}</Row>}
          {s.plan.plan && <Row label="Plan">{s.plan.plan}</Row>}
          {s.plan.renews && <Row label="Renews">{fmt(s.plan.renews)}</Row>}
        </>
      ) : (
        <p className="text-xs text-muted">The provider did not report plan usage.</p>
      )}
      {s.caps && (
        <Row label={<>Atlas caps per account<SourceTag source="atlas" /></>}>
          {n(s.caps.daily)}/day · {n(s.caps.monthly)}/month
        </Row>
      )}
    </ServiceCard>
  );
}

function ServicesSection({ s }: { s: Services }) {
  const or = s.openrouter;
  const el = s.elevenlabs;
  return (
    <div className="mb-8 grid gap-4 lg:grid-cols-2">
      <ServiceCard
        title="OpenRouter (free models only)"
        configured={or.configured}
        status={or.freeDailyLimitReached ? <Badge tone="warn">Free daily limit reached</Badge> : <Badge tone="accent">Available</Badge>}
      >
        {or.reported ? (
          <>
            <Row label={<>Free tier<SourceTag source="provider" /></>}>{or.reported.freeTier === null ? '–' : or.reported.freeTier ? 'Yes' : 'No'}</Row>
            {or.reported.freeDailyRemaining !== null && <Row label="Free requests left today">{n(or.reported.freeDailyRemaining)}</Row>}
            <Row label="Credits remaining">{or.reported.creditsRemaining === null ? 'None (not used)' : n(or.reported.creditsRemaining)}</Row>
          </>
        ) : (
          <p className="text-xs text-muted">OpenRouter did not report the account status.</p>
        )}
        <p className="mt-2 text-xs text-muted">{or.note}</p>
      </ServiceCard>
      <ServiceCard title="ElevenLabs (voice)" configured={el.configured} status={el.enabled ? <Badge tone="accent">On</Badge> : <Badge>Off in settings</Badge>}>
        {el.balance && (
          <Row label={<>Credits left<SourceTag source="provider" /></>}>
            {n(el.balance.remainingCredits)}
            {!el.balance.active && <span className="ml-1.5 font-normal text-muted">(subscription inactive)</span>}
          </Row>
        )}
        <Row label={<>Credits today<SourceTag source="atlas" /></>}>
          {n(el.today.credits)}
          {el.caps ? ` / ${n(el.caps.appDaily)}` : ''}
        </Row>
        <Row label="Credits this month">
          {n(el.month.credits)}
          {el.caps ? ` / ${n(el.caps.appMonthly)}` : ''}
        </Row>
        <Row label="Requests today">
          {n(el.today.requests)}
          {el.today.failed > 0 && <span className="ml-1.5 font-normal text-muted">({el.today.failed} failed)</span>}
        </Row>
        {el.caps && <Row label="Per account per day">{n(el.caps.perUserDaily)} credits</Row>}
      </ServiceCard>
      <SearchCard title="Tavily (search)" s={s.tavily} />
      <SearchCard title="SerpAPI (search)" s={s.serpapi} />
    </div>
  );
}

const REASON: Record<string, string> = {
  rpm: 'Per-minute limit',
  rpd: 'Daily quota used up',
  daily_allowance: 'Daily allowance used up',
  auth: 'Credentials rejected',
  unavailable: 'Model unavailable',
  outage: 'Temporary outage',
  guard: 'Paused by Atlas',
  failover: 'Failover',
};

const fmt = (t: string | null) =>
  t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
const label = (provider: string, id: string) => `${provider === 'gemini' ? 'Gemini project' : 'Cloudflare account'} ${id}`;

function Status({ cooldowns, usable = true, usedUp = false }: { cooldowns: Cooldown[]; usable?: boolean; usedUp?: boolean }) {
  const whole = cooldowns.find((c) => c.model === null);
  if (usedUp) return <Badge tone="danger">Allowance used up</Badge>;
  if (whole?.reason === 'auth') return <Badge tone="danger">Credentials rejected</Badge>;
  if (whole || !usable) return <Badge tone="warn">Resting</Badge>;
  if (cooldowns.length) return <Badge tone="warn">Partly limited</Badge>;
  return <Badge tone="accent">Available</Badge>;
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0 text-muted">{label}</span>
      <span className="max-w-[55%] shrink-0 truncate text-right font-medium tabular-nums">{children}</span>
    </div>
  );
}

function Cooldowns({ list }: { list: Cooldown[] }) {
  if (!list.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-muted">
      {list.map((c, i) => (
        <li key={i}>
          {c.model ? <span className="font-medium text-fg">{c.model.replace(/_/g, '.').replace(/^gemini\.(\d)\.(\d)/, 'gemini-$1.$2')}</span> : 'Whole account'}
          {': '}
          {REASON[c.reason] ?? c.reason} until {fmt(c.until)}
        </li>
      ))}
    </ul>
  );
}

export default function ProvidersPage() {
  const { admin } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Overview>('admin', { json: { action: 'providers' } }));
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'failed', message: err instanceof ApiError ? err.message : 'Provider status could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  if (!admin) return <Navigate to="/" replace />;
  const refresh = (
    <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
      Refresh
    </Button>
  );

  return (
    <Page title="Provider Monitoring" wide actions={refresh}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">Provider Monitoring</h1>
          {refresh}
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<Cpu className="size-6" />} title="Provider status could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !data ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading provider status
          </div>
        ) : (
          <>
            <p className="mb-5 text-sm text-muted">
              Free tiers only. When an account reaches a limit it rests and requests move to the other account; when both are
              unavailable Atlas AI continues with the next approved free model. Paid usage is never started.
            </p>

            <h2 className="mb-2 text-sm font-semibold">Google Gemini</h2>
            <p className="mb-3 text-xs text-muted">
              Day {data.gemini.day} (quotas reset at {data.gemini.resetsAt}). Requests per day are counted by Atlas AI; limits
              marked “reported” come from Google’s own responses for that project.
            </p>
            {data.gemini.accounts.length === 0 ? (
              <EmptyState icon={<Cpu className="size-6" />} title="No Gemini project configured" />
            ) : (
              <div className="mb-8 grid gap-4 lg:grid-cols-2">
                {data.gemini.accounts.map((a) => (
                  <section key={a.id} className="rounded-2xl border border-border px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="font-semibold">{label('gemini', a.id)}</div>
                      <Status cooldowns={a.cooldowns} />
                    </div>
                    <Row label="Last success">{fmt(a.lastSuccess)}</Row>
                    <Row label="Last failure">
                      {fmt(a.lastFailure)}
                      {a.lastError && <span className="ml-1.5 font-normal text-muted">({a.lastError})</span>}
                    </Row>
                    <Row label="Requests taken over from the other project today">{a.switchedTo}</Row>
                    <Cooldowns list={a.cooldowns} />
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-left text-xs tabular-nums">
                        <thead className="text-muted">
                          <tr>
                            <th className="py-1 pr-2 font-medium">Model</th>
                            <th className="py-1 pr-2 font-medium">Today</th>
                            <th className="py-1 pr-2 font-medium">Left today</th>
                            <th className="py-1 pr-2 font-medium">Last min</th>
                            <th className="py-1 pr-2 font-medium">Limited</th>
                            <th className="py-1 font-medium">Failed</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {a.models.map((m) => (
                            <tr key={m.model} className={cn(a.modelsListed && !a.modelsListed.includes(m.model) && 'opacity-50')}>
                              <td className="py-1 pr-2">
                                {m.model}
                                {a.modelsListed && !a.modelsListed.includes(m.model) && <span className="ml-1 text-muted">(not listed)</span>}
                              </td>
                              <td className="py-1 pr-2">{m.requestsToday}</td>
                              <td className="py-1 pr-2" title={m.rpd ? `${m.rpd} per day (${m.limitSource})` : 'Daily limit not published for this model'}>
                                {m.remainingToday === null ? '–' : `${m.remainingToday} / ${m.rpd}`}
                              </td>
                              <td className="py-1 pr-2" title={m.rpm ? `Limit ${m.rpm}/min; Atlas stops at ${m.rpmGuard} (this server instance)` : undefined}>
                                {m.lastMinute}
                                {m.rpmGuard ? ` / ${m.rpmGuard}` : ''}
                              </td>
                              <td className="py-1 pr-2">{m.rateLimited}</td>
                              <td className="py-1">{m.failed}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
              </div>
            )}

            <h2 className="mb-2 text-sm font-semibold">Cloudflare Workers AI</h2>
            <p className="mb-3 text-xs text-muted">
              Day {data.cloudflare.day} (allowance resets at {data.cloudflare.resetsAt}). Each account has {data.cloudflare.freeAllowance.toLocaleString()} free
              Neurons a day; Atlas AI stops each account at {data.cloudflare.atlasCap?.toLocaleString() ?? '–'}.
            </p>
            {data.cloudflare.accounts.length === 0 ? (
              <EmptyState icon={<Cpu className="size-6" />} title="No Cloudflare account configured" />
            ) : (
              <div className="mb-8 grid gap-4 lg:grid-cols-2">
                {data.cloudflare.accounts.map((a) => (
                  <section key={a.id} className="rounded-2xl border border-border px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="font-semibold">{label('cloudflare', a.id)}</div>
                      <Status cooldowns={a.cooldowns} usable={a.usable} usedUp={a.allowanceUsedUp} />
                    </div>
                    <Row label="Neurons used today">{a.neuronsToday.toLocaleString()}</Row>
                    <Row label="Left under Atlas cap">{a.remainingUnderCap === null ? '–' : a.remainingUnderCap.toLocaleString()}</Row>
                    <Row label="Reserved by running requests">{a.reservedNow.toLocaleString()}</Row>
                    <Row label="Requests today">
                      {a.requests}
                      {a.failed > 0 && <span className="ml-1.5 font-normal text-muted">({a.failed} failed)</span>}
                    </Row>
                    <Row label="Last success (this server)">{fmt(a.lastSuccess)}</Row>
                    <Row label="Last failure (this server)">
                      {fmt(a.lastFailure)}
                      {a.lastError && <span className="ml-1.5 font-normal text-muted">({a.lastError})</span>}
                    </Row>
                    <Cooldowns list={a.cooldowns} />
                  </section>
                ))}
              </div>
            )}

            {data.services && (
              <>
                <h2 className="mb-2 text-sm font-semibold">Other services</h2>
                <p className="mb-3 text-xs text-muted">
                  “Reported by provider” figures come from each provider’s own account endpoint (these checks use no quota). “Atlas counter” figures are Atlas AI’s own
                  counts and caps. A figure a provider does not report is shown as –.
                </p>
                <ServicesSection s={data.services} />
              </>
            )}

            <h2 className="mb-3 text-sm font-semibold">Recent limits and switches</h2>
            {data.events.length === 0 ? (
              <EmptyState icon={<Cpu className="size-6" />} title="Nothing yet">
                Rate limits, account switches and rejected credentials appear here.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {data.events.map((e) => (
                  <li key={e.id} className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
                    <div className="text-xs text-muted tabular-nums">{fmt(e.at)}</div>
                    <div className="min-w-0">
                      {e.kind === 'switch' ? (
                        <>
                          Switched {e.provider === 'gemini' ? 'Gemini' : 'Cloudflare'} from {e.account} to {e.to}
                          {e.model && <span className="text-muted"> · {e.model}</span>}
                          <span className="text-muted"> · {REASON[e.reason ?? ''] ?? e.reason}</span>
                        </>
                      ) : e.kind === 'auth' ? (
                        <span className="text-danger">
                          {label(e.provider ?? '', e.account ?? '?')}: credentials rejected. Check the server setting.
                        </span>
                      ) : (
                        <>
                          {label(e.provider ?? '', e.account ?? '?')} resting: {REASON[e.reason ?? ''] ?? e.reason}
                          {e.model && <span className="text-muted"> · {e.model}</span>}
                          {e.until && <span className="text-muted"> · until {fmt(e.until)}</span>}
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
