import {
  Activity,
  BarChart3,
  Check,
  Copy,
  FlaskConical,
  KeyRound,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  ScrollText,
  ShieldAlert,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, Dialog, EmptyState, Input, Label, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import {
  API_FEATURE_LABEL,
  API_FEATURES,
  APP_TYPE_LABEL,
  APP_TYPES,
  ENV_CHOICES,
  LIMIT_INFO,
  LIMIT_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_INFO,
  PERMISSION_REQUIRES,
  PROFILE_LABEL,
  PROFILE_LIMITS,
  USAGE_PROFILES,
  type ApiKeyView,
  type ApiLimits,
  type ApiLogRow,
  type ApiPermission,
  type AppType,
  type EnvChoice,
  type IntegrationConfig,
  type KeyLimits,
  type KeyMode,
  type NumericLimitKey,
  type UsageProfile,
} from '../../../server/shared/apiPlatform';
import { ENV_LABEL, ENVIRONMENTS, type EnvId } from '../../../server/shared/environments';
import { Page } from '../shell/Page';

/* ------------------------------------------------------------------ types */

interface Overview {
  totals: { integrations: number; active: number; suspended: number; disabled: number; keys: number; activeKeys: number; connectedApps: number };
  today: { requests: number; ok: number; failed: number; avgMs: number; rateLimited: number };
  month: { requests: number };
  recent: ApiLogRow[];
  names: Record<string, string>;
}
type Listed = IntegrationConfig & { keyCount: number; requestsToday: number };
interface Detail {
  integration: IntegrationConfig;
  keys: ApiKeyView[];
  monthRequests: number;
}
interface Analytics {
  days: number;
  series: { day: string; requests: number; ok: number; failed: number; avgMs: number; rateLimited: number; denied: number; providerErrors: number }[];
  hourly: { hour: number; requests: number; failed: number }[];
  features: { feature: string; requests: number; failed: number }[];
  environments: { environment: string; requests: number }[];
  statuses: { status: number; requests: number }[];
  apps: { integrationId: string; requests: number; failed: number }[];
  keys: { keyId: string; requests: number; failed: number }[];
  units: Record<string, number> | null;
}
interface AuditRow {
  id: string;
  action: string;
  integrationId: string;
  keyId: string | null;
  adminEmail: string | null;
  before: unknown;
  after: unknown;
  success: boolean;
  error: string | null;
  at: number;
}
interface TestResult {
  status: number;
  ms: number;
  contentType: string;
  rateLimit: { limit: string | null; remaining: string | null; reset: string | null };
  requestId: string | null;
  body: string;
  truncated: boolean;
}
/** The full key, shown once */
interface Revealed {
  secret: string;
  key: ApiKeyView;
  title: string;
}

type Tab = 'overview' | 'integrations' | 'analytics' | 'activity' | 'audit' | 'test';

const when = (v: number | string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const num = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toLocaleString());
const call = <T,>(op: Record<string, unknown>) => api<T>('admin', { json: { action: 'apiManagement', op } });
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function statusTone(s: string): 'accent' | 'warn' | 'danger' | 'neutral' {
  return s === 'active' ? 'accent' : s === 'suspended' || s === 'disabled' ? 'warn' : s === 'revoked' ? 'danger' : 'neutral';
}

function Card({ title, icon, actions, children, className }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-border p-4', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              {icon}
              {title}
            </h2>
          )}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warn' }) {
  return (
    <div className="rounded-xl bg-surface p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'danger' && 'text-danger', tone === 'warn' && 'text-warn')}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

function Bars({ rows, label }: { rows: { key: string; value: number; failed?: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1.5" aria-label={label}>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-xs">
          <div className="w-28 shrink-0 truncate text-muted" title={r.key}>
            {r.key}
          </div>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <div className="w-20 shrink-0 text-right tabular-nums">
            {r.value.toLocaleString()}
            {r.failed ? <span className="text-danger"> · {r.failed}</span> : null}
          </div>
        </div>
      ))}
      {!rows.length && <p className="text-xs text-muted">No requests in this period.</p>}
    </div>
  );
}

/** Requests per day: successful (accent) and failed (danger), stacked. */
function DayChart({ series }: { series: Analytics['series'] }) {
  const max = Math.max(1, ...series.map((s) => s.requests));
  return (
    <div>
      <div className="flex h-36 items-end gap-1" role="img" aria-label="Requests per day">
        {series.map((s) => (
          <div key={s.day} className="flex h-full flex-1 flex-col justify-end" title={`${s.day}: ${s.ok} ok, ${s.failed} failed, avg ${s.avgMs} ms`}>
            <div className="w-full rounded-t bg-danger/80" style={{ height: `${(s.failed / max) * 100}%` }} />
            <div className={cn('w-full bg-accent', !s.failed && 'rounded-t')} style={{ height: `${(s.ok / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{series[0]?.day}</span>
        <span>{series[series.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      icon={done ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/* ------------------------------------------------------------ the editor */

interface Draft {
  name: string;
  appName: string;
  appDescription: string;
  appType: AppType;
  status: 'active' | 'suspended' | 'disabled';
  permissions: ApiPermission[];
  profile: UsageProfile;
  limits: ApiLimits;
  expiresAt: string;
  allowedEnvironments: EnvId[];
  environment: { live: EnvChoice; test: EnvChoice };
  allowedModels: string;
  allowedOrigins: string;
}

const emptyDraft = (): Draft => ({
  name: '',
  appName: '',
  appDescription: '',
  appType: 'mobile',
  status: 'active',
  permissions: [],
  profile: 'standard',
  limits: { ...PROFILE_LIMITS.standard },
  expiresAt: '',
  allowedEnvironments: ['main'],
  environment: { live: 'active', test: 'active' },
  allowedModels: '',
  allowedOrigins: '',
});

const toDateInput = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const fromDateInput = (v: string) => (v ? Date.parse(`${v}T23:59:59Z`) : null);

function draftOf(i: IntegrationConfig): Draft {
  return {
    name: i.name,
    appName: i.appName,
    appDescription: i.appDescription,
    appType: i.appType,
    status: i.status === 'deleted' ? 'disabled' : i.status,
    permissions: [...i.permissions],
    profile: i.profile,
    limits: { ...i.limits },
    expiresAt: toDateInput(i.expiresAt),
    allowedEnvironments: [...i.allowedEnvironments],
    environment: { ...i.environment },
    allowedModels: (i.allowedModels ?? []).join('\n'),
    allowedOrigins: i.allowedOrigins.join('\n'),
  };
}

function configOf(d: Draft) {
  const lines = (v: string) => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return {
    name: d.name.trim(),
    appName: d.appName.trim(),
    appDescription: d.appDescription.trim(),
    appType: d.appType,
    status: d.status,
    permissions: d.permissions,
    profile: d.profile,
    limits: d.profile === 'custom' ? d.limits : undefined,
    expiresAt: fromDateInput(d.expiresAt),
    allowedEnvironments: d.allowedEnvironments,
    environment: d.environment,
    allowedModels: lines(d.allowedModels).length ? lines(d.allowedModels) : null,
    allowedOrigins: lines(d.allowedOrigins),
  };
}

function LimitField({ k, value, onChange, disabled }: { k: NumericLimitKey; value: number | null; onChange: (v: number | null) => void; disabled?: boolean }) {
  return (
    <div>
      <Label htmlFor={`lim-${k}`}>{LIMIT_INFO[k].label}</Label>
      <Input
        id={`lim-${k}`}
        inputMode="numeric"
        placeholder="No limit"
        disabled={disabled}
        value={value === null ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d]/g, '');
          onChange(v === '' ? null : Number(v));
        }}
      />
    </div>
  );
}

function IntegrationEditor({
  open,
  initial,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Draft;
  editing: IntegrationConfig | null;
  onClose: () => void;
  onSaved: (r: { integration: IntegrationConfig; key?: { view: ApiKeyView; secret: string } | null }) => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [firstKey, setFirstKey] = useState<KeyMode | 'none'>('live');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setD(initial);
      setErr('');
      setFirstKey('live');
    }
  }, [open, initial]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const togglePerm = (p: ApiPermission, on: boolean) =>
    setD((prev) => {
      let next = on ? [...new Set([...prev.permissions, p])] : prev.permissions.filter((x) => x !== p);
      const req = PERMISSION_REQUIRES[p];
      if (on && req && !next.includes(req)) next.push(req);
      // turning a permission off also turns off what depends on it
      if (!on) next = next.filter((x) => PERMISSION_REQUIRES[x] !== p);
      return { ...prev, permissions: next };
    });
  const setProfile = (profile: UsageProfile) =>
    setD((p) => ({ ...p, profile, limits: profile === 'custom' ? { ...p.limits } : { ...PROFILE_LIMITS[profile] } }));
  const toggleEnv = (e: EnvId, on: boolean) =>
    setD((p) => {
      const allowed = on ? ENVIRONMENTS.filter((x) => x === e || p.allowedEnvironments.includes(x)) : p.allowedEnvironments.filter((x) => x !== e);
      const fix = (c: EnvChoice): EnvChoice => (c !== 'active' && !allowed.includes(c) ? 'active' : c);
      return { ...p, allowedEnvironments: allowed, environment: { live: fix(p.environment.live), test: fix(p.environment.test) } };
    });

  const save = async () => {
    setErr('');
    if (d.name.trim().length < 2) return setErr('Enter an API name (at least 2 characters).');
    if (!d.allowedEnvironments.length) return setErr('Allow at least one environment.');
    setBusy(true);
    try {
      if (editing) {
        const r = await call<{ integration: IntegrationConfig }>({ op: 'update', id: editing.id, version: editing.version, config: configOf(d) });
        toast('Saved. New requests use the new settings at once.', 'success');
        onSaved({ integration: r.integration });
      } else {
        const r = await call<{ integration: IntegrationConfig; key: { view: ApiKeyView; secret: string } | null }>({
          op: 'create',
          config: configOf(d),
          ...(firstKey !== 'none' ? { firstKey: { name: firstKey === 'live' ? 'Production key' : 'Test key', mode: firstKey } } : {}),
        });
        onSaved(r);
      }
    } catch (e) {
      setErr(message(e, 'The integration could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const envOptions = () =>
    ENV_CHOICES.filter((c) => c === 'active' || d.allowedEnvironments.includes(c as EnvId)).map((c) => ({ value: c, label: c === 'active' ? 'Active global environment' : ENV_LABEL[c as EnvId] })) as {
      value: EnvChoice;
      label: string;
    }[];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${editing.name}` : 'Create New API'}
      description="Nothing is granted by default: choose exactly what this application may do. Every change is checked on the server and recorded in the audit log."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {editing ? 'Save changes' : 'Create API'}
          </Button>
        </>
      }
    >
      <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
        {err && <p className="rounded-lg bg-danger-soft p-2 text-sm text-danger">{err}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="api-name">API name</Label>
            <Input id="api-name" value={d.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="Messaging app API" />
          </div>
          <div>
            <Label htmlFor="api-app">Application name</Label>
            <Input id="api-app" value={d.appName} maxLength={80} onChange={(e) => set('appName', e.target.value)} placeholder="Atlas Messenger" />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="api-desc">Description</Label>
            <Textarea id="api-desc" rows={2} value={d.appDescription} maxLength={500} onChange={(e) => set('appDescription', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="api-type">Application type</Label>
            <Select id="api-type" value={d.appType} onChange={(v) => set('appType', v)} options={APP_TYPES.map((t) => ({ value: t, label: APP_TYPE_LABEL[t] }))} />
          </div>
          <div>
            <Label htmlFor="api-status">Status</Label>
            <Select
              id="api-status"
              value={d.status}
              onChange={(v) => set('status', v)}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
          </div>
          <div>
            <Label htmlFor="api-exp" hint="Empty: never expires.">
              Expiration date
            </Label>
            <Input id="api-exp" type="date" value={d.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Capabilities</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {PERMISSION_GROUPS.map((g) => (
              <div key={g.label} className="rounded-xl bg-surface p-3">
                <div className="mb-2 text-[13px] font-medium">{g.label}</div>
                <div className="space-y-2">
                  {g.items.map((p) => (
                    <div key={p} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px]">{PERMISSION_INFO[p].label}</div>
                        <div className="text-[11px] text-muted">{PERMISSION_INFO[p].explain}</div>
                      </div>
                      <Switch checked={d.permissions.includes(p)} onChange={(on) => togglePerm(p, on)} label={PERMISSION_INFO[p].label} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Usage limits</h3>
          <div className="mb-3 max-w-xs">
            <Label htmlFor="api-profile" hint="Unlimited removes this application’s own quotas; the provider safeguards and abuse protection always stay on.">
              Profile
            </Label>
            <Select id="api-profile" value={d.profile} onChange={setProfile} options={USAGE_PROFILES.map((p) => ({ value: p, label: PROFILE_LABEL[p] }))} />
          </div>
          {(['Requests', 'Size', 'Features'] as const).map((group) => (
            <div key={group} className="mb-3">
              <div className="mb-1.5 text-xs font-medium text-muted">{group}</div>
              <div className="grid gap-3 sm:grid-cols-3">
                {LIMIT_KEYS.filter((k) => LIMIT_INFO[k].group === group).map((k) => (
                  <LimitField key={k} k={k} value={d.limits[k]} disabled={d.profile !== 'custom'} onChange={(v) => setD((p) => ({ ...p, limits: { ...p.limits, [k]: v } }))} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Switch checked={d.limits.streaming} disabled={d.profile !== 'custom'} onChange={(v) => setD((p) => ({ ...p, limits: { ...p.limits, streaming: v } }))} label="Streaming access" />
            <span className="text-[13px]">Streaming access</span>
          </div>
          {d.profile !== 'custom' && <p className="mt-2 text-xs text-muted">Choose Custom to change individual limits.</p>}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Environments</h3>
          <div className="mb-3 flex flex-wrap gap-4">
            {ENVIRONMENTS.map((e) => (
              <label key={e} className="flex items-center gap-2 text-[13px]">
                <Switch checked={d.allowedEnvironments.includes(e)} onChange={(on) => toggleEnv(e, on)} label={`Allow ${ENV_LABEL[e]}`} />
                {ENV_LABEL[e]}
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['live', 'test'] as const).map((mode) => (
              <div key={mode}>
                <Label htmlFor={`env-${mode}`} hint={mode === 'live' ? 'atlas_live_ keys' : 'atlas_test_ keys'}>
                  {mode === 'live' ? 'Live keys use' : 'Test keys use'}
                </Label>
                <Select id={`env-${mode}`} value={d.environment[mode]} onChange={(v) => setD((p) => ({ ...p, environment: { ...p.environment, [mode]: v } }))} options={envOptions()} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            A provider whose environment is not allowed is refused for this application, never moved to other credentials. ElevenLabs is shared by every environment.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="api-models" hint="One model id per line. Empty: every approved free model.">
              Allowed models
            </Label>
            <Textarea id="api-models" rows={3} value={d.allowedModels} onChange={(e) => set('allowedModels', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="api-origins" hint="Websites allowed to call the API from a browser, one per line. Empty: server-to-server only.">
              Allowed browser origins
            </Label>
            <Textarea id="api-origins" rows={3} value={d.allowedOrigins} onChange={(e) => set('allowedOrigins', e.target.value)} placeholder="https://app.example.com" />
          </div>
        </div>

        {!editing && (
          <div className="max-w-xs">
            <Label htmlFor="api-firstkey" hint="The key is shown once, after creation.">
              First API key
            </Label>
            <Select
              id="api-firstkey"
              value={firstKey}
              onChange={setFirstKey}
              options={[
                { value: 'live', label: 'Create a live key' },
                { value: 'test', label: 'Create a test key' },
                { value: 'none', label: 'No key yet' },
              ]}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* --------------------------------------------------------------- key dialogs */

function RevealDialog({ revealed, onClose }: { revealed: Revealed | null; onClose: () => void }) {
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [revealed]);
  return (
    <Dialog
      open={Boolean(revealed)}
      onClose={() => ack && onClose()}
      title={revealed?.title ?? ''}
      description="Copy this key now and store it in the application’s server-side secrets. It is shown only once: Atlas AI keeps only a hash and cannot show it again."
      footer={
        <Button variant="primary" disabled={!ack} onClick={onClose}>
          Done
        </Button>
      }
    >
      {revealed && (
        <div className="space-y-3">
          <code className="block break-all rounded-lg bg-surface p-3 font-mono text-[13px]">{revealed.secret}</code>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={revealed.secret} label="Copy key" />
            <Badge tone={revealed.key.mode === 'live' ? 'accent' : 'warn'}>{revealed.key.mode}</Badge>
            <span className="text-xs text-muted">{revealed.key.name}</span>
          </div>
          <p className="text-xs text-muted">Never put this key in a mobile app, browser code or a public repository. Send it from your server as “Authorization: Bearer …”.</p>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I have stored the key safely.
          </label>
        </div>
      )}
    </Dialog>
  );
}

function KeyLimitsEditor({ value, onChange }: { value: KeyLimits; onChange: (v: KeyLimits) => void }) {
  const keys: NumericLimitKey[] = ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay', 'requestsPerMonth', 'maxConcurrent', 'imagesPerDay', 'researchPerDay'];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {keys.map((k) => (
        <LimitField key={k} k={k} value={value[k] ?? null} onChange={(v) => onChange({ ...value, [k]: v })} />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- detail view */

function IntegrationDetail({ id, onBack, onEdit, onChanged, reveal }: { id: string; onBack: () => void; onEdit: (i: IntegrationConfig) => void; onChanged: () => void; reveal: (r: Revealed) => void }) {
  const toast = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ open: boolean; name: string; mode: KeyMode; expires: string; limits: KeyLimits }>({ open: false, name: '', mode: 'live', expires: '', limits: {} });
  const [editKey, setEditKey] = useState<{ key: ApiKeyView; name: string; expires: string; limits: KeyLimits } | null>(null);
  // `run` receives the dialog's inputs as they are when Confirm is pressed (not when the dialog opened)
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: (input: { typed: string; grace: number }) => Promise<void>; danger?: boolean; typed?: string; grace?: boolean } | null>(null);
  const [typed, setTyped] = useState('');
  const [grace, setGrace] = useState('0');

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([call<Detail>({ op: 'get', id }), call<Analytics>({ op: 'analytics', days: 14, integrationId: id })]);
      setData(d);
      setStats(a);
    } catch (e) {
      setErr(message(e, 'The integration could not be loaded.'));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      toast(message(e, 'The change could not be saved.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (err) return <EmptyState icon={<ShieldAlert className="size-6" />} title="Not available">{err}</EmptyState>;
  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  const i = data.integration;
  const total = stats?.series.reduce((n, s) => n + s.requests, 0) ?? 0;
  const failed = stats?.series.reduce((n, s) => n + s.failed, 0) ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← All integrations
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={<Pencil className="size-4" />} onClick={() => onEdit(i)}>
            Edit settings
          </Button>
          {i.status === 'active' ? (
            <Button size="sm" variant="outline" icon={<Power className="size-4" />} loading={busy === 'status'} onClick={() => void run('status', async () => void (await call({ op: 'setStatus', id, status: 'suspended' })))}>
              Suspend
            </Button>
          ) : (
            <Button size="sm" variant="outline" icon={<Power className="size-4" />} loading={busy === 'status'} onClick={() => void run('status', async () => void (await call({ op: 'setStatus', id, status: 'active' })))}>
              Activate
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 className="size-4" />}
            onClick={() => {
              setTyped('');
              setConfirm({
                title: `Delete ${i.name}?`,
                body: 'Every key is revoked at once and the application can no longer use Atlas AI. Logs and analytics are kept for their normal retention. This cannot be undone.',
                danger: true,
                typed: i.name,
                run: async ({ typed: confirmName }) => {
                  await call({ op: 'delete', id, confirmName });
                  toast('Integration deleted.', 'success');
                  onBack();
                },
              });
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <Card
        title={
          <>
            {i.name} <Badge tone={statusTone(i.status)}>{i.status}</Badge>
          </>
        }
        icon={<Webhook className="size-4" />}
      >
        <div className="grid gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs text-muted">Application</div>
            {i.appName || '–'} · {APP_TYPE_LABEL[i.appType]}
          </div>
          <div>
            <div className="text-xs text-muted">App ID</div>
            <span className="font-mono text-xs">{i.id}</span> <CopyButton text={i.id} />
          </div>
          <div>
            <div className="text-xs text-muted">Profile</div>
            {PROFILE_LABEL[i.profile]}
          </div>
          <div>
            <div className="text-xs text-muted">Expires</div>
            {i.expiresAt ? when(i.expiresAt) : 'Never'}
          </div>
          <div>
            <div className="text-xs text-muted">Environments</div>
            {i.allowedEnvironments.map((e) => ENV_LABEL[e]).join(', ')} · live: {i.environment.live === 'active' ? 'active' : ENV_LABEL[i.environment.live]} · test:{' '}
            {i.environment.test === 'active' ? 'active' : ENV_LABEL[i.environment.test]}
          </div>
          <div>
            <div className="text-xs text-muted">Last used</div>
            {when(i.lastUsedAt)}
          </div>
          <div>
            <div className="text-xs text-muted">Requests this month</div>
            {num(data.monthRequests)}
          </div>
          <div>
            <div className="text-xs text-muted">Updated</div>
            {when(i.updatedAt)} {i.updatedBy ? `by ${i.updatedBy}` : ''}
          </div>
        </div>
        {i.appDescription && <p className="mt-3 text-[13px] text-muted">{i.appDescription}</p>}
        <div className="mt-3 flex flex-wrap gap-1">
          {i.permissions.length ? i.permissions.map((p) => <Badge key={p} tone="accent">{PERMISSION_INFO[p].label}</Badge>) : <Badge tone="warn">No permissions</Badge>}
        </div>
      </Card>

      <Card
        title="API keys"
        icon={<KeyRound className="size-4" />}
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewKey({ open: true, name: '', mode: 'live', expires: '', limits: {} })}>
            New key
          </Button>
        }
      >
        {!data.keys.length ? (
          <p className="text-sm text-muted">No keys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Key</th>
                  <th className="pr-2 font-medium">Status</th>
                  <th className="pr-2 font-medium">Created</th>
                  <th className="pr-2 font-medium">Last used</th>
                  <th className="pr-2 font-medium">Expires</th>
                  <th className="font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id} className="border-t border-border align-top">
                    <td className="py-2 pr-2">
                      <div className="font-medium">{k.name}</div>
                      <div className="font-mono text-[11px] text-muted">{k.display}</div>
                      {k.limits && <div className="text-[11px] text-muted">Own limits set</div>}
                    </td>
                    <td className="pr-2">
                      <Badge tone={statusTone(k.status)}>{k.status}</Badge> <Badge tone={k.mode === 'live' ? 'accent' : 'warn'}>{k.mode}</Badge>
                    </td>
                    <td className="pr-2">{when(k.createdAt)}</td>
                    <td className="pr-2">{when(k.lastUsedAt)}</td>
                    <td className="pr-2">{k.expiresAt ? when(k.expiresAt) : 'Never'}</td>
                    <td className="py-1.5">
                      {k.status !== 'revoked' && (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditKey({ key: k, name: k.name, expires: toDateInput(k.expiresAt), limits: { ...(k.limits ?? {}) } })}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy === `st-${k.id}`}
                            onClick={() => void run(`st-${k.id}`, async () => void (await call({ op: 'keySetStatus', keyId: k.id, status: k.status === 'active' ? 'disabled' : 'active' })))}
                          >
                            {k.status === 'active' ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<RotateCw className="size-3.5" />}
                            onClick={() => {
                              setGrace('0');
                              setConfirm({
                                title: `Rotate ${k.name}?`,
                                body: 'A new key with the same settings is created and shown once. The old key stops working at once, or after the grace period you choose.',
                                grace: true,
                                run: async ({ grace: graceMinutes }) => {
                                  const r = await call<{ key: ApiKeyView; secret: string }>({ op: 'keyRotate', keyId: k.id, graceMinutes });
                                  reveal({ secret: r.secret, key: r.key, title: 'New key after rotation' });
                                },
                              });
                            }}
                          >
                            Rotate
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-danger"
                            onClick={() =>
                              setConfirm({
                                title: `Revoke ${k.name}?`,
                                body: 'The key stops working immediately and cannot be turned back on.',
                                danger: true,
                                run: async () => void (await call({ op: 'keyRevoke', keyId: k.id })),
                              })
                            }
                          >
                            Revoke
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {stats && (
        <Card title="Last 14 days" icon={<BarChart3 className="size-4" />}>
          <div className="mb-4 grid gap-2 sm:grid-cols-4">
            <Stat label="Requests" value={num(total)} />
            <Stat label="Failed" value={num(failed)} tone={failed ? 'danger' : undefined} />
            <Stat label="Rate limited" value={num(stats.series.reduce((n, s) => n + s.rateLimited, 0))} />
            <Stat label="Permission denied" value={num(stats.series.reduce((n, s) => n + s.denied, 0))} />
          </div>
          <DayChart series={stats.series} />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium text-muted">By feature</div>
              <Bars label="Requests by feature" rows={stats.features.map((f) => ({ key: API_FEATURE_LABEL[f.feature as keyof typeof API_FEATURE_LABEL] ?? f.feature, value: f.requests, failed: f.failed }))} />
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted">By key</div>
              <Bars label="Requests by key" rows={stats.keys.map((k) => ({ key: data.keys.find((x) => x.id === k.keyId)?.name ?? k.keyId, value: k.requests, failed: k.failed }))} />
            </div>
          </div>
          {stats.units && (
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted">
              {Object.entries(stats.units).map(([u, v]) => (
                <Badge key={u}>
                  {u.replace('_', ' ')}: {v.toLocaleString()}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      )}

      <AuditList integrationId={id} />

      {/* new key */}
      <Dialog
        open={newKey.open}
        onClose={() => setNewKey((p) => ({ ...p, open: false }))}
        title="New API key"
        description="An application can have several keys (for example one per server or environment). Key limits apply in addition to the application’s limits."
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewKey((p) => ({ ...p, open: false }))}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'newkey'}
              disabled={!newKey.name.trim()}
              onClick={() =>
                void run('newkey', async () => {
                  const r = await call<{ key: ApiKeyView; secret: string }>({
                    op: 'keyCreate',
                    integrationId: id,
                    name: newKey.name.trim(),
                    mode: newKey.mode,
                    expiresAt: fromDateInput(newKey.expires),
                    limits: Object.values(newKey.limits).some((v) => v !== null && v !== undefined) ? newKey.limits : null,
                  });
                  setNewKey((p) => ({ ...p, open: false }));
                  reveal({ secret: r.secret, key: r.key, title: 'Your new API key' });
                })
              }
            >
              Create key
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="nk-name">Name</Label>
              <Input id="nk-name" value={newKey.name} maxLength={80} onChange={(e) => setNewKey((p) => ({ ...p, name: e.target.value }))} placeholder="Production server" />
            </div>
            <div>
              <Label htmlFor="nk-mode">Mode</Label>
              <Select
                id="nk-mode"
                value={newKey.mode}
                onChange={(v) => setNewKey((p) => ({ ...p, mode: v }))}
                options={[
                  { value: 'live', label: 'Live (atlas_live_)' },
                  { value: 'test', label: 'Test (atlas_test_)' },
                ]}
              />
            </div>
            <div>
              <Label htmlFor="nk-exp">Expires</Label>
              <Input id="nk-exp" type="date" value={newKey.expires} onChange={(e) => setNewKey((p) => ({ ...p, expires: e.target.value }))} />
            </div>
          </div>
          <div className="text-xs font-medium text-muted">Key limits (optional)</div>
          <KeyLimitsEditor value={newKey.limits} onChange={(limits) => setNewKey((p) => ({ ...p, limits }))} />
        </div>
      </Dialog>

      {/* edit key */}
      <Dialog
        open={Boolean(editKey)}
        onClose={() => setEditKey(null)}
        title={`Edit ${editKey?.key.name ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditKey(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'editkey'}
              disabled={!editKey?.name.trim()}
              onClick={() =>
                editKey &&
                void run('editkey', async () => {
                  await call({
                    op: 'keyUpdate',
                    keyId: editKey.key.id,
                    name: editKey.name.trim(),
                    expiresAt: fromDateInput(editKey.expires),
                    limits: Object.values(editKey.limits).some((v) => v !== null && v !== undefined) ? editKey.limits : null,
                  });
                  setEditKey(null);
                  toast('Key saved.', 'success');
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        {editKey && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ek-name">Name</Label>
                <Input id="ek-name" value={editKey.name} maxLength={80} onChange={(e) => setEditKey({ ...editKey, name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="ek-exp">Expires</Label>
                <Input id="ek-exp" type="date" value={editKey.expires} onChange={(e) => setEditKey({ ...editKey, expires: e.target.value })} />
              </div>
            </div>
            <KeyLimitsEditor value={editKey.limits} onChange={(limits) => setEditKey({ ...editKey, limits })} />
          </div>
        )}
      </Dialog>

      {/* confirmations */}
      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.body}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.danger ? 'danger' : 'primary'}
              loading={busy === 'confirm'}
              disabled={Boolean(confirm?.typed) && typed.trim() !== confirm?.typed}
              onClick={() =>
                confirm &&
                void run('confirm', async () => {
                  await confirm.run({ typed: typed.trim(), grace: Math.min(10_080, Number(grace) || 0) });
                  setConfirm(null);
                })
              }
            >
              Confirm
            </Button>
          </>
        }
      >
        {confirm?.typed && (
          <div>
            <Label htmlFor="typed-name">Type “{confirm.typed}” to confirm</Label>
            <Input id="typed-name" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        {confirm?.grace && (
          <div className="max-w-xs">
            <Label htmlFor="grace" hint="0 = the old key stops immediately.">
              Grace period (minutes)
            </Label>
            <Input id="grace" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/[^\d]/g, ''))} />
          </div>
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------- audit trail */

function AuditList({ integrationId, names }: { integrationId?: string; names?: Record<string, string> }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void call<{ rows: AuditRow[] }>({ op: 'audit', integrationId }).then(
      (r) => setRows(r.rows),
      () => setRows([]),
    );
  }, [integrationId]);
  return (
    <Card title="Change history" icon={<ScrollText className="size-4" />}>
      {!rows ? (
        <Spinner />
      ) : !rows.length ? (
        <p className="text-sm text-muted">No changes recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border text-[13px]">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <button className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <Badge tone={r.success ? 'accent' : 'danger'}>{r.success ? 'success' : 'failed'}</Badge>
                <span className="font-medium">{r.action.replace(/^api_/, '').replace(/_/g, ' ')}</span>
                {!integrationId && <span className="text-muted">{names?.[r.integrationId] ?? r.integrationId}</span>}
                <span className="ml-auto text-xs text-muted">
                  {r.adminEmail ?? '–'} · {when(r.at)}
                </span>
              </button>
              {open === r.id && (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <pre className="max-h-60 overflow-auto rounded-lg bg-surface p-2 text-[11px]">{JSON.stringify(r.before, null, 2)}</pre>
                  <pre className="max-h-60 overflow-auto rounded-lg bg-surface p-2 text-[11px]">{JSON.stringify(r.after, null, 2)}</pre>
                </div>
              )}
              {r.error && <div className="mt-1 text-xs text-danger">{r.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- activity */

function ActivityTable({ integrations }: { integrations: Listed[] }) {
  const [filter, setFilter] = useState({ integrationId: '', keyId: '', feature: '', environment: '', status: '', from: '', to: '', source: '' });
  const [data, setData] = useState<{ rows: ApiLogRow[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => Object.fromEntries(integrations.map((i) => [i.id, i.name])), [integrations]);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const f: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(filter)) {
        if (!v) continue;
        // a partly typed key id is ignored rather than sent (the server only accepts a full id)
        if (k === 'keyId' && !/^key_[a-f0-9]{16}$/.test(v)) continue;
        f[k] = k === 'from' || k === 'to' ? Date.parse(`${v}T${k === 'from' ? '00:00:00' : '23:59:59'}Z`) : v;
      }
      setData(await call({ op: 'activity', filter: f }));
    } catch {
      setData({ rows: [], truncated: false });
    } finally {
      setBusy(false);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);
  const opt = (label: string, entries: [string, string][]) => [{ value: '', label }, ...entries.map(([value, l]) => ({ value, label: l }))];
  return (
    <Card
      title="Recent activity"
      icon={<Activity className="size-4" />}
      actions={
        <Button size="sm" variant="outline" icon={<RefreshCw className="size-4" />} loading={busy} onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Select value={filter.integrationId} onChange={(v) => setFilter({ ...filter, integrationId: v, keyId: '' })} options={opt('All applications', integrations.map((i) => [i.id, i.name]))} />
        <Input placeholder="Key id (key_…)" value={filter.keyId} onChange={(e) => setFilter({ ...filter, keyId: e.target.value.trim() })} />
        <Select value={filter.feature} onChange={(v) => setFilter({ ...filter, feature: v })} options={opt('All features', API_FEATURES.map((f) => [f, API_FEATURE_LABEL[f]]))} />
        <Select value={filter.environment} onChange={(v) => setFilter({ ...filter, environment: v })} options={opt('All environments', [...ENVIRONMENTS.map((e) => [e, ENV_LABEL[e]] as [string, string]), ['mixed', 'Mixed']])} />
        <Select
          value={filter.status}
          onChange={(v) => setFilter({ ...filter, status: v })}
          options={opt('All results', [
            ['success', 'Successful'],
            ['failed', 'Failed'],
            ['rate_limited', 'Rate limited'],
            ['denied', 'Permission denied'],
            ['provider_error', 'Provider errors'],
          ])}
        />
        <Select value={filter.source} onChange={(v) => setFilter({ ...filter, source: v })} options={opt('API and test console', [['api', 'API only'], ['admin_test', 'Test console only']])} />
        <Input type="date" aria-label="From" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />
        <Input type="date" aria-label="To" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />
      </div>
      {!data ? (
        <Spinner />
      ) : !data.rows.length ? (
        <p className="text-sm text-muted">No requests match these filters (logs are kept for 30 days).</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12px]">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Time</th>
                <th className="pr-2 font-medium">Application</th>
                <th className="pr-2 font-medium">Request</th>
                <th className="pr-2 font-medium">Status</th>
                <th className="pr-2 font-medium">Time taken</th>
                <th className="pr-2 font-medium">Environment</th>
                <th className="font-medium">Model</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1.5 pr-2 whitespace-nowrap">{when(r.at)}</td>
                  <td className="pr-2">
                    {names[r.integrationId] ?? r.integrationId}
                    <div className="font-mono text-[10px] text-muted">
                      {r.keyId ?? '–'} {r.source === 'admin_test' ? '· test console' : ''}
                    </div>
                  </td>
                  <td className="pr-2 font-mono">
                    {r.method} {r.endpoint}
                  </td>
                  <td className="pr-2">
                    <Badge tone={r.status < 400 ? 'accent' : r.status === 429 ? 'warn' : 'danger'}>{r.status}</Badge> {r.code && <span className="text-muted">{r.code}</span>}
                  </td>
                  <td className="pr-2 tabular-nums">{r.ms.toLocaleString()} ms</td>
                  <td className="pr-2">{r.environment ? (r.environment === 'mixed' ? 'Mixed' : ENV_LABEL[r.environment]) : '–'}</td>
                  <td className="max-w-[180px] truncate" title={r.model ?? ''}>
                    {r.model ?? '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.truncated && <p className="mt-2 text-xs text-muted">Showing the newest requests only; narrow the date range to see older ones.</p>}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ test console */

const TEST_ENDPOINTS: { value: string; label: string }[] = [
  { value: 'app', label: 'GET /v1/app' },
  { value: 'models', label: 'GET /v1/models' },
  { value: 'chat', label: 'POST /v1/chat' },
  { value: 'chat_stream', label: 'POST /v1/chat (streaming)' },
  { value: 'research_search', label: 'POST /v1/research (search)' },
  { value: 'research_answer', label: 'POST /v1/research (answer with sources)' },
  { value: 'images', label: 'POST /v1/images' },
  { value: 'documents_upload', label: 'POST /v1/documents' },
  { value: 'documents_list', label: 'GET /v1/documents' },
  { value: 'conversations_list', label: 'GET /v1/conversations' },
  { value: 'memory_list', label: 'GET /v1/memory' },
  { value: 'voice_speech', label: 'POST /v1/voice/speech' },
];

function TestConsole({ integrations }: { integrations: Listed[] }) {
  const toast = useToast();
  const usable = integrations.filter((i) => i.status === 'active');
  const [integrationId, setIntegrationId] = useState(usable[0]?.id ?? '');
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [keyId, setKeyId] = useState('');
  const [endpoint, setEndpoint] = useState('chat');
  const [input, setInput] = useState('');
  const [model, setModel] = useState('auto');
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!integrationId) return;
    void call<Detail>({ op: 'get', id: integrationId }).then(
      (d) => {
        const active = d.keys.filter((k) => k.status === 'active');
        setKeys(active);
        setKeyId(active[0]?.id ?? '');
      },
      () => setKeys([]),
    );
  }, [integrationId]);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await call<TestResult>({ op: 'test', integrationId, keyId, endpoint, input, model: model.trim() || 'auto' }));
    } catch (e) {
      toast(message(e, 'The test request could not be sent.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!usable.length) return <EmptyState icon={<FlaskConical className="size-6" />} title="No active integration">Create or activate an integration to test it.</EmptyState>;
  return (
    <Card title="API test console" icon={<FlaskConical className="size-4" />}>
      <p className="mb-3 text-xs text-muted">
        Requests go through the real API pipeline with the chosen key’s permissions, limits and environment, and count against them. They run as the end user “admin-test”, never with provider credentials in the browser.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label htmlFor="t-int">Integration</Label>
          <Select id="t-int" value={integrationId} onChange={setIntegrationId} options={usable.map((i) => ({ value: i.id, label: i.name }))} />
        </div>
        <div>
          <Label htmlFor="t-key">Key</Label>
          {keys.length ? <Select id="t-key" value={keyId} onChange={setKeyId} options={keys.map((k) => ({ value: k.id, label: `${k.name} (${k.mode})` }))} /> : <p className="text-sm text-muted">No active key.</p>}
        </div>
        <div>
          <Label htmlFor="t-ep">Feature</Label>
          <Select id="t-ep" value={endpoint} onChange={setEndpoint} options={TEST_ENDPOINTS} />
        </div>
        <div>
          <Label htmlFor="t-model">Model</Label>
          <Input id="t-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" />
        </div>
      </div>
      <div className="mt-3">
        <Label htmlFor="t-input" hint="Message, query, prompt or text, depending on the feature. Empty: a short example.">
          Input
        </Label>
        <Textarea id="t-input" rows={3} maxLength={4000} value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      <div className="mt-3">
        <Button variant="primary" loading={busy} disabled={!keyId} onClick={() => void send()}>
          Send request
        </Button>
      </div>
      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Badge tone={result.status < 400 ? 'accent' : result.status === 429 ? 'warn' : 'danger'}>HTTP {result.status}</Badge>
            <Badge>{result.ms.toLocaleString()} ms</Badge>
            {result.rateLimit.limit && (
              <Badge>
                Rate limit {result.rateLimit.remaining}/{result.rateLimit.limit}
              </Badge>
            )}
            {result.requestId && <span className="font-mono text-[11px] text-muted">{result.requestId}</span>}
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-lg bg-surface p-3 text-[11px] whitespace-pre-wrap break-all">{prettyBody(result.body)}</pre>
          {result.truncated && <p className="text-xs text-muted">The response was shortened for display.</p>}
        </div>
      )}
    </Card>
  );
}

function prettyBody(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/* --------------------------------------------------------------------- page */

/**
 * API Management (Super Admin): applications connected to Atlas AI through the API, their keys,
 * permissions, limits and environments, usage analytics, request activity, the change history and a
 * test console. Keys are shown once at creation; provider credentials never reach this page.
 */
export default function ApiManagementPage() {
  const { admin } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [list, setList] = useState<Listed[] | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [days, setDays] = useState('14');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; draft: Draft; editing: IntegrationConfig | null }>({ open: false, draft: emptyDraft(), editing: null });
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [detailKey, setDetailKey] = useState(0);

  const load = useCallback(async () => {
    setError('');
    try {
      const [o, l] = await Promise.all([call<Overview>({ op: 'overview' }), call<{ integrations: Listed[] }>({ op: 'list' })]);
      setOverview(o);
      setList(l.integrations);
    } catch (e) {
      setError(message(e, 'API Management could not be loaded.'));
    }
  }, []);
  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);
  useEffect(() => {
    if (!admin || tab !== 'analytics') return;
    void call<Analytics>({ op: 'analytics', days: Number(days) }).then(setAnalytics, (e) => toast(message(e, 'Analytics could not be loaded.'), 'error'));
  }, [admin, tab, days, toast]);

  if (!admin) return <Navigate to="/settings" replace />;

  const names = overview?.names ?? {};
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'integrations', label: 'Integrations' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'activity', label: 'Activity' },
    { id: 'audit', label: 'Change history' },
    { id: 'test', label: 'Test console' },
  ];

  return (
    <Page title="API Management" wide>
      <div className="mb-5 hidden flex-wrap items-end justify-between gap-3 lg:flex">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Webhook className="size-6" aria-hidden="true" /> API Management
          </h1>
          <p className="mt-1 text-sm text-muted">
            Applications that use Atlas AI through its API: keys, permissions, limits, environments and usage.{' '}
            <a href="/developers" target="_blank" rel="noreferrer" className="underline">
              API documentation
            </a>{' '}
            ·{' '}
            <a href="/developers/sandbox" target="_blank" rel="noreferrer" className="underline">
              Sandbox
            </a>
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ open: true, draft: emptyDraft(), editing: null })}>
          Create New API
        </Button>
      </div>
      <div className="mb-4 lg:hidden">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ open: true, draft: emptyDraft(), editing: null })}>
          Create New API
        </Button>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              if (t.id !== 'integrations') setSelected(null);
            }}
            className={cn('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap', tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <EmptyState icon={<ShieldAlert className="size-6" />} title="Not available">
          {error}
        </EmptyState>
      ) : !overview || !list ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          {tab === 'overview' && (
            <div className="space-y-5">
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Total APIs" value={num(overview.totals.integrations)} />
                <Stat label="Active" value={num(overview.totals.active)} />
                <Stat label="Suspended / disabled" value={num(overview.totals.suspended + overview.totals.disabled)} tone={overview.totals.suspended + overview.totals.disabled ? 'warn' : undefined} />
                <Stat label="Connected apps" value={num(overview.totals.connectedApps)} hint="used at least once" />
                <Stat label="Active keys" value={num(overview.totals.activeKeys)} hint={`${num(overview.totals.keys)} in total`} />
                <Stat label="Requests this month" value={num(overview.month.requests)} />
              </div>
              <div className="grid gap-2 sm:grid-cols-5">
                <Stat label="Requests today" value={num(overview.today.requests)} />
                <Stat label="Successful today" value={num(overview.today.ok)} />
                <Stat label="Failed today" value={num(overview.today.failed)} tone={overview.today.failed ? 'danger' : undefined} />
                <Stat label="Rate limited today" value={num(overview.today.rateLimited)} />
                <Stat label="Average response" value={`${num(overview.today.avgMs)} ms`} />
              </div>
              <Card title="Recent activity" icon={<Activity className="size-4" />}>
                {!overview.recent.length ? (
                  <p className="text-sm text-muted">No API requests yet.</p>
                ) : (
                  <ul className="divide-y divide-border text-[13px]">
                    {overview.recent.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
                        <Badge tone={r.status < 400 ? 'accent' : r.status === 429 ? 'warn' : 'danger'}>{r.status}</Badge>
                        <span className="font-mono text-xs">
                          {r.method} {r.endpoint}
                        </span>
                        <span className="text-muted">{names[r.integrationId] ?? r.integrationId}</span>
                        <span className="ml-auto text-xs text-muted">
                          {r.ms} ms · {when(r.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}

          {tab === 'integrations' &&
            (selected ? (
              <IntegrationDetail
                key={`${selected}-${detailKey}`}
                id={selected}
                onBack={() => {
                  setSelected(null);
                  void load();
                }}
                onEdit={(i) => setEditor({ open: true, draft: draftOf(i), editing: i })}
                onChanged={() => void load()}
                reveal={setRevealed}
              />
            ) : !list.length ? (
              <EmptyState
                icon={<Webhook className="size-6" />}
                title="No APIs yet"
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ open: true, draft: emptyDraft(), editing: null })}>
                    Create New API
                  </Button>
                }
              >
                Create an API for each application that should use Atlas AI.
              </EmptyState>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {list.map((i) => (
                  <button key={i.id} onClick={() => setSelected(i.id)} className="rounded-2xl border border-border p-4 text-left transition-colors hover:bg-surface">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{i.name}</div>
                        <div className="truncate text-xs text-muted">
                          {i.appName || APP_TYPE_LABEL[i.appType]} · {PROFILE_LABEL[i.profile]}
                        </div>
                      </div>
                      <Badge tone={statusTone(i.status)}>{i.status}</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
                      <span>{i.permissions.length} permissions</span>
                      <span>{i.keyCount} keys</span>
                      <span>{num(i.requestsToday)} requests today</span>
                      <span>Last used {when(i.lastUsedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            ))}

          {tab === 'analytics' && (
            <div className="space-y-5">
              <div className="max-w-[180px]">
                <Select
                  value={days}
                  onChange={setDays}
                  options={[
                    { value: '7', label: 'Last 7 days' },
                    { value: '14', label: 'Last 14 days' },
                    { value: '30', label: 'Last 30 days' },
                    { value: '90', label: 'Last 90 days' },
                  ]}
                />
              </div>
              {!analytics ? (
                <Spinner />
              ) : (
                <>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Stat label="Requests" value={num(analytics.series.reduce((n, s) => n + s.requests, 0))} />
                    <Stat label="Successful" value={num(analytics.series.reduce((n, s) => n + s.ok, 0))} />
                    <Stat label="Failed" value={num(analytics.series.reduce((n, s) => n + s.failed, 0))} />
                    <Stat
                      label="Average response"
                      value={`${num(Math.round(analytics.series.reduce((n, s) => n + s.avgMs * s.requests, 0) / Math.max(1, analytics.series.reduce((n, s) => n + s.requests, 0))))} ms`}
                    />
                    <Stat label="Rate-limit events" value={num(analytics.series.reduce((n, s) => n + s.rateLimited, 0))} />
                    <Stat label="Permission failures" value={num(analytics.series.reduce((n, s) => n + s.denied, 0))} hint={`${num(analytics.series.reduce((n, s) => n + s.providerErrors, 0))} provider errors`} />
                  </div>
                  <Card title="Requests over time" icon={<BarChart3 className="size-4" />}>
                    <DayChart series={analytics.series} />
                    <div className="mt-4 text-xs font-medium text-muted">Today by hour (UTC)</div>
                    <div className="mt-2 flex h-16 items-end gap-0.5">
                      {analytics.hourly.map((h) => {
                        const max = Math.max(1, ...analytics.hourly.map((x) => x.requests));
                        return <div key={h.hour} title={`${h.hour}:00 · ${h.requests} requests, ${h.failed} failed`} className="flex-1 rounded-t bg-accent/70" style={{ height: `${(h.requests / max) * 100}%` }} />;
                      })}
                    </div>
                  </Card>
                  <div className="grid gap-5 md:grid-cols-2">
                    <Card title="By application">
                      <Bars label="By application" rows={analytics.apps.map((a) => ({ key: names[a.integrationId] ?? a.integrationId, value: a.requests, failed: a.failed }))} />
                    </Card>
                    <Card title="By feature">
                      <Bars label="By feature" rows={analytics.features.map((f) => ({ key: API_FEATURE_LABEL[f.feature as keyof typeof API_FEATURE_LABEL] ?? f.feature, value: f.requests, failed: f.failed }))} />
                    </Card>
                    <Card title="By environment">
                      <Bars label="By environment" rows={analytics.environments.map((e) => ({ key: e.environment === 'mixed' ? 'Mixed' : ENV_LABEL[e.environment as EnvId], value: e.requests }))} />
                    </Card>
                    <Card title="By key">
                      <Bars label="By key" rows={analytics.keys.slice(0, 12).map((k) => ({ key: k.keyId, value: k.requests, failed: k.failed }))} />
                    </Card>
                    <Card title="By status code" className="md:col-span-2">
                      <div className="flex flex-wrap gap-2">
                        {analytics.statuses.map((s) => (
                          <Badge key={s.status} tone={s.status < 400 ? 'accent' : s.status === 429 ? 'warn' : 'danger'}>
                            {s.status}: {s.requests.toLocaleString()}
                          </Badge>
                        ))}
                        {!analytics.statuses.length && <span className="text-xs text-muted">No requests in this period.</span>}
                      </div>
                    </Card>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'activity' && <ActivityTable integrations={list} />}
          {tab === 'audit' && <AuditList names={names} />}
          {tab === 'test' && <TestConsole integrations={list} />}
        </>
      )}

      <IntegrationEditor
        open={editor.open}
        initial={editor.draft}
        editing={editor.editing}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
        onSaved={(r) => {
          setEditor((e) => ({ ...e, open: false }));
          void load();
          setTab('integrations');
          setSelected(r.integration.id);
          setDetailKey((k) => k + 1);
          if (r.key) setRevealed({ secret: r.key.secret, key: r.key.view, title: 'Your new API key' });
          else if (!editor.editing) toast('API created.', 'success');
        }}
      />
      <RevealDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </Page>
  );
}
