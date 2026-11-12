import { Infinity as InfinityIcon, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, Label, Select, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import { fmtTime, toLocalInput, usageOp, type UsageUserRow } from './usageAdmin';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

type Length = 'permanent' | '1h' | '1d' | '7d' | '30d' | 'until';
const DURATIONS: { value: Length; label: string; ms?: number }[] = [
  { value: 'permanent', label: 'Permanently (until removed)' },
  { value: '1h', label: 'For 1 hour', ms: 3_600_000 },
  { value: '1d', label: 'For 1 day', ms: 86_400_000 },
  { value: '7d', label: 'For 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'For 30 days', ms: 30 * 86_400_000 },
  { value: 'until', label: 'Until a date and time' },
];

/**
 * Unlimited AI access: which accounts have it, granting it (permanently, for a time, or until a
 * date) and removing it. Removing it restores the account's own profile and limits. Provider
 * safeguards (free quotas, cooldowns) still apply to unlimited accounts.
 */
export default function UnlimitedAccessPage() {
  const toast = useToast();
  const [rows, setRows] = useState<UsageUserRow[] | null>(null);
  const [tz, setTz] = useState('Africa/Accra');
  const [q, setQ] = useState('');
  const [grantFor, setGrantFor] = useState<UsageUserRow | null>(null);
  const [length, setLength] = useState<Length>('7d');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [confirmGrant, setConfirmGrant] = useState(false);
  const [revoke, setRevoke] = useState<UsageUserRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    usageOp<{ users: UsageUserRow[]; timezone: string }>({ op: 'users' })
      .then((r) => {
        setRows(r.users);
        setTz(r.timezone);
      })
      .catch((e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  const unlimited = useMemo(() => (rows ?? []).filter((r) => r.unlimited), [rows]);
  const matches = useMemo(
    () => (q.trim().length < 2 ? [] : (rows ?? []).filter((r) => !r.unlimited && `${r.email} ${r.name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)),
    [rows, q],
  );

  const endTime = (): number | null => {
    if (length === 'permanent') return null;
    if (length === 'until') return until ? new Date(until).getTime() : NaN;
    return Date.now() + (DURATIONS.find((d) => d.value === length)?.ms ?? 0);
  };
  const describe = () => {
    const e = endTime();
    return e === null ? 'permanently, until an administrator removes it' : Number.isNaN(e) ? '' : `until ${fmtTime(e, tz)} (${tz})`;
  };

  const grant = async () => {
    if (!grantFor) return;
    try {
      await usageOp({ op: 'unlimited', uid: grantFor.uid, grant: true, until: endTime(), reason: reason || undefined, confirm: true });
      toast('Unlimited AI access granted', 'success');
      setGrantFor(null);
      setQ('');
      load();
    } catch (e) {
      toast(errText(e), 'error');
    }
  };

  const openGrant = (r: UsageUserRow) => {
    setGrantFor(r);
    setLength('7d');
    setUntil('');
    setReason('');
  };

  return (
    <Page title="Unlimited Access" wide>
      <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Unlimited Access</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted">
        Accounts with no individual AI allowance. Administrators are unlimited automatically. Removing a grant restores the account's own profile and limits. Provider
        safeguards (free quotas and cooldowns) always apply.
      </p>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !rows ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <section className="mb-8">
            <Label htmlFor="grant-search">Grant unlimited access</Label>
            <div className="relative w-full max-w-lg">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
              <Input id="grant-search" className="pl-9" placeholder="Search an account by email or name" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {matches.length > 0 && (
              <ul className="mt-2 max-w-lg divide-y divide-border rounded-xl border border-border">
                {matches.map((r) => (
                  <li key={r.uid} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{r.email ?? r.name}</div>
                      <div className="text-xs text-subtle">{r.profile.name}</div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openGrant(r)}>
                      Grant
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {q.trim().length >= 2 && !matches.length && <p className="mt-2 text-xs text-subtle">No account without unlimited access matches.</p>}
          </section>

          <h2 className="mb-3 text-[15px] font-semibold">Accounts with unlimited access ({unlimited.length})</h2>
          {!unlimited.length ? (
            <EmptyState icon={<InfinityIcon className="size-5" />} title="No unlimited accounts">Grant unlimited access above.</EmptyState>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {unlimited.map((r) => (
                <li key={r.uid} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="truncate text-sm">{r.email ?? r.name}</div>
                    <div className="text-xs text-subtle">
                      {r.unlimited === 'admin'
                        ? 'Administrator (automatic)'
                        : r.unlimited === 'profile'
                          ? 'Unlimited profile'
                          : r.unlimitedUntil
                            ? `Granted until ${fmtTime(r.unlimitedUntil, tz)}`
                            : 'Granted permanently'}
                    </div>
                  </div>
                  <Badge tone="accent">{r.unlimited === 'admin' ? 'Admin' : r.unlimited === 'profile' ? 'Profile' : r.unlimitedUntil ? 'Temporary' : 'Permanent'}</Badge>
                  {r.unlimited === 'grant' && (
                    <Button size="sm" variant="ghost" onClick={() => setRevoke(r)}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-subtle">An account on the Unlimited profile is changed from AI Usage &amp; Limits. Expired grants end on their own and are recorded in the audit log.</p>
        </>
      )}

      <Dialog
        open={Boolean(grantFor)}
        onClose={() => setGrantFor(null)}
        title="Grant unlimited AI access"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGrantFor(null)}>
              Cancel
            </Button>
            <Button disabled={length === 'until' && (!until || new Date(until).getTime() <= Date.now())} onClick={() => setConfirmGrant(true)}>
              Continue
            </Button>
          </>
        }
      >
        {grantFor && (
          <div className="space-y-3 text-sm">
            <p>
              Account: <span className="font-medium break-all">{grantFor.email ?? grantFor.name}</span>
            </p>
            <div>
              <Label htmlFor="ulen">How long</Label>
              <Select id="ulen" value={length} onChange={(v) => setLength(v)} options={DURATIONS.map((d) => ({ value: d.value, label: d.label }))} />
            </div>
            {length === 'until' && (
              <div>
                <Label htmlFor="uuntil" hint="Your device's local time.">
                  Ends
                </Label>
                <Input id="uuntil" type="datetime-local" min={toLocalInput(Date.now())} value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
            )}
            <div>
              <Label htmlFor="ureason" hint="Recorded in the audit log.">
                Reason (optional)
              </Label>
              <Input id="ureason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmGrant}
        onClose={() => setConfirmGrant(false)}
        onConfirm={async () => {
          setConfirmGrant(false);
          await grant();
        }}
        title="Grant unlimited access?"
        message={`${grantFor?.email ?? 'This account'} will have no individual AI limits ${describe()}. Provider safeguards still apply.`}
        confirmLabel="Grant"
      />
      <ConfirmDialog
        open={Boolean(revoke)}
        onClose={() => setRevoke(null)}
        onConfirm={async () => {
          if (!revoke) return;
          try {
            await usageOp({ op: 'unlimited', uid: revoke.uid, grant: false, confirm: true });
            toast('Unlimited access removed', 'success');
            load();
          } catch (e) {
            toast(errText(e), 'error');
          }
          setRevoke(null);
        }}
        title="Remove unlimited access?"
        message={`${revoke?.email ?? 'This account'} goes back to the ${revoke?.profile.name ?? 'default'} profile and its own limits straight away.`}
        confirmLabel="Remove"
        danger
      />
    </Page>
  );
}
