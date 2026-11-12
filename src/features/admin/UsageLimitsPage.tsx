import { Plus, RotateCcw, Save, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, ConfirmDialog, Dialog, Input, Label, Select, Spinner, Switch } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import {
  fmtTime,
  toLocalInput,
  usageOp,
  WEEKDAYS,
  type FeatureId,
  type FeatureInfo,
  type Limits,
  type PeriodLimit,
  type UsageConfig,
  type UsageUserDetail,
  type UsageUserRow,
} from './usageAdmin';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** A number box where empty means "no limit". */
function LimitInput({ value, onChange, label }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string }) {
  return (
    <Input
      type="number"
      min={0}
      inputMode="numeric"
      aria-label={label}
      placeholder="No limit"
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      className="h-9 w-[4.5rem] text-right tabular-nums sm:w-24"
    />
  );
}

function LimitsTable({ features, limits, onChange }: { features: FeatureInfo[]; limits: Limits; onChange: (f: FeatureId, p: PeriodLimit) => void }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-subtle">
          <th className="py-1.5 font-medium">Feature</th>
          <th className="py-1.5 text-right font-medium whitespace-nowrap">Per day</th>
          <th className="py-1.5 pl-2 text-right font-medium whitespace-nowrap">Per week</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {features.map((f) => (
          <tr key={f.id}>
            <td className="py-1.5 pr-2">
              <div>{f.label}</div>
              <div className="hidden text-[11px] text-subtle sm:block">{f.explain}</div>
            </td>
            <td className="py-1.5 text-right">
              <div className="flex justify-end">
                <LimitInput label={`${f.label} per day`} value={limits[f.id].daily} onChange={(v) => onChange(f.id, { ...limits[f.id], daily: v })} />
              </div>
            </td>
            <td className="py-1.5 pl-2 text-right">
              <div className="flex justify-end">
                <LimitInput label={`${f.label} per week`} value={limits[f.id].weekly} onChange={(v) => onChange(f.id, { ...limits[f.id], weekly: v })} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ title, description, children, actions }: { title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="border-t border-border py-6 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A switch with its label visible (Switch on its own only names itself for screen readers). */
function SwitchRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn('flex min-h-11 items-center justify-between gap-3 text-sm', disabled && 'opacity-60')}>
      <span>{label}</span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsSection({ cfg, features, onSaved }: { cfg: UsageConfig; features: FeatureInfo[]; onSaved: (c: UsageConfig) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(cfg);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => setDraft(cfg), [cfg]);
  const dirty = JSON.stringify({ e: draft.enabled, f: draft.features, r: draft.reset, d: draft.defaultProfile }) !== JSON.stringify({ e: cfg.enabled, f: cfg.features, r: cfg.reset, d: cfg.defaultProfile });
  const save = async () => {
    setBusy(true);
    try {
      const r = await usageOp<{ config: UsageConfig }>({ op: 'config', enabled: draft.enabled, features: draft.features, reset: draft.reset, defaultProfile: draft.defaultProfile });
      onSaved(r.config);
      toast('Usage settings saved', 'success');
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      return [];
    }
  }, []);
  return (
    <Section
      title="Limits and resets"
      description="Individual allowances per feature. Provider safeguards (free quotas) always apply, whatever is set here."
      actions={
        <Button size="sm" icon={<Save className="size-4" />} disabled={!dirty} loading={busy} onClick={() => (cfg.enabled && !draft.enabled ? setConfirmOff(true) : void save())}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <SwitchRow checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Individual AI limits are on" />
        <div className="grid grid-cols-1 gap-x-8 border-t border-border pt-1 sm:grid-cols-2">
          {features.map((f) => (
            <SwitchRow
              key={f.id}
              checked={draft.features[f.id].enabled}
              disabled={!draft.enabled}
              onChange={(v) => setDraft({ ...draft, features: { ...draft.features, [f.id]: { enabled: v } } })}
              label={`Limit ${f.label.toLowerCase()}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="tz" hint="Resets follow this time zone, including daylight-saving changes.">
              Time zone
            </Label>
            <Input id="tz" list="tz-list" value={draft.reset.timezone} onChange={(e) => setDraft({ ...draft, reset: { ...draft.reset, timezone: e.target.value } })} />
            <datalist id="tz-list">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          <div>
            <Label htmlFor="defprof" hint="Used by every account without its own profile.">
              Default profile
            </Label>
            <Select
              id="defprof"
              value={draft.defaultProfile}
              onChange={(v) => setDraft({ ...draft, defaultProfile: v })}
              options={Object.entries(cfg.profiles)
                .filter(([, p]) => !p.unlimited)
                .map(([id, p]) => ({ value: id, label: p.name }))}
            />
          </div>
          <div>
            <Label htmlFor="dtime">Daily reset time</Label>
            <Input id="dtime" type="time" value={draft.reset.dailyTime} onChange={(e) => setDraft({ ...draft, reset: { ...draft.reset, dailyTime: e.target.value } })} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="wday">Weekly reset</Label>
              <Select
                id="wday"
                value={String(draft.reset.weeklyDay)}
                onChange={(v) => setDraft({ ...draft, reset: { ...draft.reset, weeklyDay: Number(v) } })}
                options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
              />
            </div>
            <div className="w-28 shrink-0">
              <Label htmlFor="wtime">Time</Label>
              <Input id="wtime" type="time" value={draft.reset.weeklyTime} onChange={(e) => setDraft({ ...draft, reset: { ...draft.reset, weeklyTime: e.target.value } })} />
            </div>
          </div>
        </div>
        <p className="text-xs text-subtle">Changing the reset time or time zone starts new periods from the next request; counts already made are not moved.</p>
      </div>
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={async () => {
          setConfirmOff(false);
          await save();
        }}
        title="Turn off individual limits?"
        message="Every account will be able to use AI features without an individual allowance. Provider safeguards still apply."
        confirmLabel="Turn off"
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ profiles */

function ProfilesSection({ cfg, features, onSaved }: { cfg: UsageConfig; features: FeatureInfo[]; onSaved: (c: UsageConfig) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string; isNew: boolean; name: string; description: string; limits: Limits } | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await usageOp<{ config: UsageConfig }>({ op: 'profileSave', id: editing.id, name: editing.name, description: editing.description, limits: editing.limits });
      onSaved(r.config);
      setEditing(null);
      toast('Profile saved', 'success');
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const fmt = (p: PeriodLimit) => `${p.daily ?? '∞'}/day · ${p.weekly ?? '∞'}/week`;
  return (
    <Section
      title="Profiles"
      description="Changing a profile's limits applies to every account on it straight away."
      actions={
        <Button
          size="sm"
          variant="outline"
          icon={<Plus className="size-4" />}
          onClick={() => setEditing({ id: '', isNew: true, name: '', description: '', limits: structuredClone(cfg.profiles.standard.limits) })}
        >
          New profile
        </Button>
      }
    >
      <ul className="divide-y divide-border rounded-xl border border-border">
        {Object.entries(cfg.profiles).map(([id, p]) => (
          <li key={id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {p.name}
                {cfg.defaultProfile === id && <Badge tone="accent">Default</Badge>}
                {p.unlimited && <Badge>No individual limits</Badge>}
              </div>
              <div className="truncate text-xs text-subtle">{p.unlimited ? p.description : `Chat ${fmt(p.limits.chat)} · Images ${fmt(p.limits.images)} · Research ${fmt(p.limits.research)}`}</div>
            </div>
            {!p.unlimited && (
              <Button size="sm" variant="ghost" onClick={() => setEditing({ id, isNew: false, name: p.name, description: p.description, limits: structuredClone(p.limits) })}>
                Edit
              </Button>
            )}
            {!p.builtin && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDel(id)} aria-label={`Delete ${p.name}`} />
            )}
          </li>
        ))}
      </ul>
      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.isNew ? 'New profile' : `Edit ${editing?.name ?? ''}`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!editing?.name.trim() || !/^[a-z][a-z0-9_]{1,30}$/.test(editing?.id ?? '')} onClick={() => void save()}>
              Save profile
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            {editing.isNew && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pname">Name</Label>
                  <Input
                    id="pname"
                    value={editing.name}
                    maxLength={40}
                    onChange={(e) => {
                      const name = e.target.value;
                      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'p_$1').slice(0, 31);
                      setEditing({ ...editing, name, id });
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="pid" hint="Lowercase letters, numbers and _.">
                    Id
                  </Label>
                  <Input id="pid" value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="pdesc">Description</Label>
              <Input id="pdesc" value={editing.description} maxLength={200} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <LimitsTable features={features} limits={editing.limits} onChange={(f, v) => setEditing({ ...editing, limits: { ...editing.limits, [f]: v } })} />
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={Boolean(del)}
        onClose={() => setDel(null)}
        onConfirm={async () => {
          try {
            await usageOp({ op: 'profileDelete', id: del, confirm: true });
            const r = await usageOp<{ config: UsageConfig }>({ op: 'get' });
            onSaved(r.config);
            toast('Profile deleted', 'success');
          } catch (e) {
            toast(errText(e), 'error');
          }
          setDel(null);
        }}
        title="Delete this profile?"
        message="Accounts on it move to the default profile. Their custom limits and unlimited access stay."
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ one account */

export function UserUsageDialog({
  uid,
  cfg,
  features,
  onClose,
  onChanged,
}: {
  uid: string | null;
  cfg: UsageConfig;
  features: FeatureInfo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<UsageUserDetail | null>(null);
  const [profile, setProfile] = useState('');
  const [custom, setCustom] = useState<Limits | null>(null);
  const [ovUntil, setOvUntil] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<{ feature: FeatureId | 'all'; period: 'daily' | 'weekly' | 'both' } | null>(null);
  const load = useCallback(async () => {
    if (!uid) return;
    const r = await usageOp<UsageUserDetail>({ op: 'user', uid });
    setD(r);
    setProfile(r.account.profile ?? cfg.defaultProfile);
    const base = cfg.profiles[r.account.profile ?? cfg.defaultProfile]?.limits ?? cfg.profiles.standard.limits;
    const merged = structuredClone(base);
    for (const f of features) merged[f.id] = { ...merged[f.id], ...(r.account.customLimits?.[f.id] ?? {}) };
    setCustom(r.account.customLimits ? merged : null);
    setOvUntil('');
    setReason('');
  }, [uid, cfg, features]);
  useEffect(() => {
    setD(null);
    void load().catch((e) => toast(errText(e), 'error'));
  }, [load, toast]);

  const apply = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await usageOp({ op: 'assign', uid, reason: reason || undefined, ...body });
      toast(done, 'success');
      await load();
      onChanged();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  /** custom limits that differ from the profile */
  const customDiff = () => {
    if (!custom) return null;
    const base = cfg.profiles[profile]?.limits ?? cfg.profiles.standard.limits;
    const out: Partial<Record<FeatureId, Partial<PeriodLimit>>> = {};
    for (const f of features) {
      const e: Partial<PeriodLimit> = {};
      if (custom[f.id].daily !== base[f.id].daily) e.daily = custom[f.id].daily;
      if (custom[f.id].weekly !== base[f.id].weekly) e.weekly = custom[f.id].weekly;
      if (Object.keys(e).length) out[f.id] = e;
    }
    return out;
  };

  return (
    <Dialog open={Boolean(uid)} onClose={onClose} title={<span className="block pr-8 break-all">{d?.email ?? 'Account usage'}</span>} size="lg">
      {!d ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Profile: <span className="font-medium text-fg">{d.snapshot.profile.name}</span>
            {d.snapshot.unlimited && <Badge tone="accent">Unlimited ({d.snapshot.unlimited === 'admin' ? 'administrator' : d.snapshot.unlimited === 'grant' ? 'granted' : 'profile'})</Badge>}
            {d.account.override && <Badge tone="warn">Temporary override{d.account.override.until ? ` until ${fmtTime(d.account.override.until, d.snapshot.timezone)}` : ''}</Badge>}
          </div>

          <table className="w-full text-[13px] sm:text-sm">
            <thead>
              <tr className="text-left text-xs text-subtle">
                <th className="py-1 font-medium">Feature</th>
                <th className="py-1 text-right font-medium">Today</th>
                <th className="py-1 text-right font-medium">This week</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {d.snapshot.features.map((f) => (
                <tr key={f.id}>
                  <td className="py-1.5">{f.label}</td>
                  <td className={cn('py-1.5 text-right tabular-nums', f.exhausted && f.binding === 'daily' && 'text-danger')}>
                    {f.daily.used}
                    {f.daily.limit !== null && <span className="text-subtle"> / {f.daily.limit}</span>}
                  </td>
                  <td className={cn('py-1.5 text-right tabular-nums', f.exhausted && f.binding === 'weekly' && 'text-danger')}>
                    {f.weekly.used}
                    {f.weekly.limit !== null && <span className="text-subtle"> / {f.weekly.limit}</span>}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setReset({ feature: f.id, period: 'both' })} aria-label={`Reset ${f.label}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button size="sm" variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => setReset({ feature: 'all', period: 'daily' })}>
            Reset today's allowance (all features)
          </Button>

          <div>
            <Label htmlFor="ureason" hint="Recorded in the audit log with each change.">
              Reason (optional)
            </Label>
            <Input id="ureason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <Label htmlFor="uprof" hint="Other settings (custom limits, unlimited access) are kept.">
                Profile
              </Label>
              <Select id="uprof" value={profile} onChange={setProfile} options={Object.entries(cfg.profiles).map(([id, p]) => ({ value: id, label: p.name }))} />
            </div>
            <Button loading={busy} disabled={profile === (d.account.profile ?? cfg.defaultProfile)} onClick={() => void apply({ profile }, 'Profile changed')}>
              Change profile
            </Button>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-medium">Custom limits for this account</span>
              {custom ? (
                <Button size="sm" variant="ghost" onClick={() => void apply({ customLimits: null }, 'Custom limits removed')}>
                  Remove custom limits
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setCustom(structuredClone(cfg.profiles[profile]?.limits ?? cfg.profiles.standard.limits))}>
                  Set custom limits
                </Button>
              )}
            </div>
            {custom && (
              <>
                <LimitsTable features={features} limits={custom} onChange={(f, v) => setCustom({ ...custom, [f]: v })} />
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <Button loading={busy} onClick={() => void apply({ customLimits: customDiff() }, 'Custom limits saved')}>
                    Save as permanent custom limits
                  </Button>
                  <span className="w-full text-xs text-subtle sm:w-auto">or as a temporary override until</span>
                  <Input type="datetime-local" className="h-9 w-full sm:w-56" value={ovUntil} min={toLocalInput(Date.now())} onChange={(e) => setOvUntil(e.target.value)} aria-label="Override ends" />
                  <Button
                    variant="outline"
                    loading={busy}
                    disabled={!ovUntil}
                    onClick={() => void apply({ override: { limits: customDiff() ?? {}, until: new Date(ovUntil).getTime() } }, 'Temporary override saved')}
                  >
                    Save override
                  </Button>
                </div>
              </>
            )}
            {d.account.override && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => void apply({ override: null }, 'Override removed')}>
                Remove the temporary override
              </Button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(reset)}
        onClose={() => setReset(null)}
        onConfirm={async () => {
          if (!reset) return;
          try {
            await usageOp({ op: 'reset', uid, feature: reset.feature, period: reset.period, reason: reason || undefined, confirm: true });
            toast('Allowance reset', 'success');
            await load();
            onChanged();
          } catch (e) {
            toast(errText(e), 'error');
          }
          setReset(null);
        }}
        title="Reset this allowance?"
        message={
          reset?.feature === 'all'
            ? "Today's usage of every feature goes back to 0 for this account."
            : `This account's ${features.find((f) => f.id === reset?.feature)?.label.toLowerCase() ?? ''} usage goes back to 0 for today and this week.`
        }
        confirmLabel="Reset"
      />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ accounts */

function UsersSection({ cfg, features }: { cfg: UsageConfig; features: FeatureInfo[] }) {
  const [rows, setRows] = useState<UsageUserRow[] | null>(null);
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  const load = useCallback(() => {
    usageOp<{ users: UsageUserRow[] }>({ op: 'users' })
      .then((r) => setRows(r.users))
      .catch((e) => toast(errText(e), 'error'));
  }, [toast]);
  useEffect(load, [load]);
  const label = (id: FeatureId) => features.find((f) => f.id === id)?.label ?? id;
  const shown = (rows ?? [])
    .filter((r) => filter === 'all' || r.exhausted.length || r.near.length)
    .filter((r) => !q || `${r.email} ${r.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Section title="Accounts" description="Who is near or at a limit today or this week. Open an account to change its profile, set custom limits or reset its allowance.">
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          value={filter}
          onChange={setFilter}
          className="h-9 w-full sm:w-56"
          options={[
            { value: 'attention', label: 'Near or at a limit' },
            { value: 'all', label: 'All accounts' },
          ]}
        />
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input className="h-9 pl-9" placeholder="Search email or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" />
        </div>
      </div>
      {!rows ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !shown.length ? (
        <p className="py-6 text-center text-sm text-subtle">{filter === 'attention' ? 'No account is near a limit right now.' : 'No accounts match.'}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {shown.slice(0, 200).map((r) => (
            <li key={r.uid}>
              <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-surface" onClick={() => setOpen(r.uid)}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{r.email ?? r.name}</div>
                  <div className="truncate text-xs text-subtle">
                    {r.profile.name}
                    {r.hasCustom ? ' · custom limits' : ''}
                    {r.override ? ' · temporary override' : ''}
                  </div>
                </div>
                <div className="flex w-full flex-wrap gap-1 sm:w-auto sm:justify-end">
                  {r.unlimited && <Badge tone="accent">Unlimited</Badge>}
                  {r.exhausted.map((f) => (
                    <Badge key={f} tone="danger">
                      {label(f)} used up
                    </Badge>
                  ))}
                  {r.near.map((f) => (
                    <Badge key={f} tone="warn">
                      {label(f)} near limit
                    </Badge>
                  ))}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <UserUsageDialog uid={open} cfg={cfg} features={features} onClose={() => setOpen(null)} onChanged={load} />
    </Section>
  );
}

export default function UsageLimitsPage() {
  const [data, setData] = useState<{ config: UsageConfig; features: FeatureInfo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    usageOp<{ config: UsageConfig; features: FeatureInfo[] }>({ op: 'get' })
      .then(setData)
      .catch((e) => setError(errText(e)));
  }, []);
  const onSaved = (config: UsageConfig) => setData((d) => (d ? { ...d, config } : d));
  return (
    <Page title="AI Usage & Limits" wide>
      <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">AI Usage & Limits</h1>
      <p className="mb-6 text-sm text-muted">Daily and weekly allowances per feature, profiles, and each account's usage. Administrators are unlimited automatically.</p>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <SettingsSection cfg={data.config} features={data.features} onSaved={onSaved} />
          <ProfilesSection cfg={data.config} features={data.features} onSaved={onSaved} />
          <UsersSection cfg={data.config} features={data.features} />
        </>
      )}
    </Page>
  );
}
