import { MessageSquareText, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, EmptyState, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { Page } from '../shell/Page';

type Delivery = 'pending' | 'sent' | 'delivered' | 'failed' | 'unavailable';
type Outcome = 'none' | 'verified' | 'wrong_code' | 'expired' | 'locked';

interface Row {
  id: string;
  at: number;
  updatedAt: number;
  purpose: 'verify' | 'recovery';
  route: 'otp' | 'sms';
  phone: string | null;
  ref: string | null;
  accepted: boolean;
  delivery: Delivery;
  providerStatus: string | null;
  error: string | null;
  outcome: Outcome;
  uid: string | null;
  user: { email: string | null; name: string | null } | null;
}

interface Overview {
  totals: { requests: number; accepted: number; rejected: number; delivered: number; failed: number; pending: number; noReceipt: number; verified: number; verificationRate: number | null };
  balances: { sms: number | null; otp: number | null; senderStatus: string | null };
  config: { sender: string | null; otpService: boolean; otpLength: number; otpExpiryMin: number; smsFallback: boolean; webhook: boolean; sandbox: boolean };
  recent: Row[];
  generatedAt: number;
}

const fmt = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={hint}>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </div>
  );
}

function DeliveryBadge({ row }: { row: Row }) {
  if (!row.accepted) return <Badge tone="danger">Rejected</Badge>;
  switch (row.delivery) {
    case 'delivered':
      return <Badge tone="accent">Delivered</Badge>;
    case 'failed':
      return <Badge tone="danger">Not delivered</Badge>;
    case 'sent':
      return <Badge tone="warn">{row.route === 'otp' ? 'Sent' : 'Sent to network'}</Badge>;
    case 'pending':
      return <Badge tone="warn">Pending</Badge>;
    default:
      return <Badge>No report</Badge>;
  }
}

const OUTCOME: Record<Outcome, string> = { none: 'Not verified', verified: 'Verified', wrong_code: 'Wrong code', expired: 'Expired', locked: 'Locked' };

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}

export default function SmsAdminPage() {
  const { admin } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Overview>('admin', { json: { action: 'sms' } }));
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'failed', message: err instanceof ApiError ? err.message : 'SMS activity could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  const rows = useMemo(() => {
    const all = data?.recent ?? [];
    if (filter === 'failed') return all.filter((r) => !r.accepted || r.delivery === 'failed');
    if (filter === 'pending') return all.filter((r) => r.accepted && (r.delivery === 'pending' || r.delivery === 'sent'));
    if (filter === 'verified') return all.filter((r) => r.outcome === 'verified');
    return all;
  }, [data, filter]);

  if (!admin) return <Navigate to="/settings" replace />;
  const refresh = (
    <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
      Refresh
    </Button>
  );

  return (
    <Page title="SMS & verification" back="/settings" wide actions={refresh}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">SMS & verification</h1>
          {refresh}
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<MessageSquareText className="size-6" />} title="SMS activity could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !data ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading SMS activity
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4">
              <Stat label="Code requests" value={data.totals.requests} hint="Most recent 500 requests" />
              <Stat label="Accepted by Vynfy" value={data.totals.accepted} />
              <Stat label="Rejected by Vynfy" value={data.totals.rejected} />
              <Stat label="Verification rate" value={data.totals.verificationRate === null ? '–' : `${data.totals.verificationRate}%`} hint="Verified codes / accepted verification requests" />
              <Stat label="Delivered" value={data.totals.delivered} />
              <Stat label="Not delivered" value={data.totals.failed} />
              <Stat label="Waiting for receipt" value={data.totals.pending} />
              <Stat label="No report yet (OTP service)" value={data.totals.noReceipt} hint="Vynfy's OTP service only reports when a code is sent to the network, not handset delivery" />
            </div>

            <div className="mb-6 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border px-4 py-2">
                <div className="py-2 text-sm font-semibold">Vynfy account</div>
                <Setting label="SMS balance">{data.balances.sms === null ? 'Unavailable' : data.balances.sms.toLocaleString()}</Setting>
                <Setting label="OTP balance">{data.balances.otp === null ? 'Unavailable' : `GHS ${data.balances.otp.toFixed(2)}`}</Setting>
                <Setting label="Sender ID">
                  {data.config.sender ?? 'Not set'}
                  {data.balances.senderStatus && <span className="ml-1.5 font-normal text-muted">({data.balances.senderStatus})</span>}
                </Setting>
              </div>
              <div className="rounded-2xl border border-border px-4 py-2">
                <div className="py-2 text-sm font-semibold">Configuration</div>
                <Setting label="Verification codes">{data.config.otpService ? `Vynfy OTP service, ${data.config.otpLength} digits, ${data.config.otpExpiryMin} min` : 'App codes over ordinary SMS'}</Setting>
                <Setting label="Fallback when OTP balance is empty">{data.config.smsFallback ? 'Ordinary SMS' : 'Off'}</Setting>
                <Setting label="Delivery webhook">{data.config.webhook ? 'Configured' : 'Not configured'}</Setting>
                {data.config.sandbox && <Setting label="Mode">Sandbox (not delivered)</Setting>}
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Recent activity</h2>
              <div className="w-44">
                <Select
                  value={filter}
                  onChange={setFilter}
                  aria-label="Filter activity"
                  options={[
                    { value: 'all', label: 'All requests' },
                    { value: 'failed', label: 'Failed or rejected' },
                    { value: 'pending', label: 'Waiting for receipt' },
                    { value: 'verified', label: 'Verified' },
                  ]}
                />
              </div>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={<MessageSquareText className="size-6" />} title="No SMS activity">
                Code requests appear here once users verify a number or reset a password by text.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {rows.map((r) => (
                  <li key={r.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
                    <div className="text-xs text-muted tabular-nums">{fmt(r.at)}</div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.user?.name || r.user?.email || (r.uid ? 'Deleted account' : 'Unknown')}</div>
                      <div className="truncate text-xs text-muted">
                        {r.phone ?? 'No number'} · {r.purpose === 'verify' ? 'Phone verification' : 'Password recovery'} · {r.route === 'otp' ? 'OTP service' : 'SMS'}
                        {r.ref && <span title="Vynfy reference"> · ref {r.ref.length > 14 ? `${r.ref.slice(0, 8)}…` : r.ref}</span>}
                      </div>
                      {(r.error || r.providerStatus) && (
                        <div className={cn('mt-0.5 break-words text-xs', r.error ? 'text-danger' : 'text-subtle')}>
                          {r.error ?? `Vynfy status: ${r.providerStatus}`}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                      <DeliveryBadge row={r} />
                      {r.purpose === 'verify' && r.accepted && <Badge tone={r.outcome === 'verified' ? 'accent' : r.outcome === 'none' ? 'neutral' : 'warn'}>{OUTCOME[r.outcome]}</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-subtle">
              Codes are never stored or shown here. "Accepted" means Vynfy took the request; only a delivery report confirms the text reached the phone. Updated {fmt(data.generatedAt)}.
            </p>
          </>
        )}
      </div>
    </Page>
  );
}
