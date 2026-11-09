import { Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, EmptyState, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { Page } from '../shell/Page';

type Status = 'accepted' | 'delivered' | 'deferred' | 'bounced' | 'blocked' | 'failed';

interface Row {
  id: string;
  at: number;
  type: string;
  to: string;
  from: string | null;
  accepted: boolean;
  status: Status;
  providerStatus: string | null;
  error: string | null;
  errorCode: string | null;
  attempts: number | null;
  opened: boolean;
}

interface Overview {
  config: {
    provider: string;
    apiKeySet: boolean;
    sender: string | null;
    senderName: string;
    dailyCap: number;
    optionalLimit: number;
    sentToday: number;
    publicUrl: string;
    senderDomainWarning: boolean;
  };
  connection: {
    state: 'unconfigured' | 'connected' | 'error';
    code: string | null;
    message: string | null;
    plan: string | null;
    credits: number | null;
  };
  totals: {
    requests: number;
    accepted: number;
    failed: number;
    delivered: number;
    deferred: number;
    bounced: number;
    blocked: number;
    awaiting: number;
  };
  byType: Record<string, number>;
  recent: Row[];
  generatedAt: number;
}

const TYPE_LABEL: Record<string, string> = {
  welcome: 'Welcome',
  verify_email: 'Email verification code',
  otp: 'Security code',
  password_reset_code: 'Password reset code',
  password_reset_requested: 'Password reset requested',
  password_changed: 'Password changed',
  new_login: 'New sign-in alert',
  suspicious_login: 'Unusual sign-in alert',
  failed_logins: 'Failed sign-ins alert',
  security_change: 'Security change',
  support_update: 'Support report update',
  access_approved: 'Account approved',
  admin_message: 'Message from admin',
};

const fmt = (t: number) =>
  new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={hint}>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </div>
  );
}

function StatusBadge({ row }: { row: Row }) {
  if (!row.accepted) return <Badge tone="danger">Not sent</Badge>;
  switch (row.status) {
    case 'delivered':
      return <Badge tone="accent">Delivered</Badge>;
    case 'deferred':
      return <Badge tone="warn">Deferred</Badge>;
    case 'bounced':
      return <Badge tone="danger">Bounced</Badge>;
    case 'blocked':
      return <Badge tone="danger">Blocked</Badge>;
    default:
      return <Badge tone="warn">Accepted</Badge>;
  }
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}

/** Today's sends against the app limit; optional emails stop at the reserve line. */
function UsageMeter({ sent, cap, optional }: { sent: number; cap: number; optional: number }) {
  const pct = cap > 0 ? Math.min(100, (sent / cap) * 100) : 0;
  const reservePct = cap > 0 ? Math.min(100, (optional / cap) * 100) : 0;
  const state =
    sent >= cap ? 'full' : sent >= optional ? 'reserve' : sent >= optional * 0.75 ? 'near' : 'ok';
  const bar =
    state === 'full'
      ? 'bg-danger'
      : state === 'reserve' || state === 'near'
        ? 'bg-warn'
        : 'bg-accent';
  return (
    <div className="py-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted">Sent today</span>
        <span className="font-medium tabular-nums">
          {sent} of {cap}
        </span>
      </div>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-border">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        <div
          className="absolute inset-y-0 w-0.5 bg-fg/40"
          style={{ left: `${reservePct}%` }}
          title="Optional emails stop here"
        />
      </div>
      <div
        className={`mt-1.5 text-xs ${state === 'ok' ? 'text-muted' : state === 'full' ? 'text-danger' : 'text-warn'}`}
      >
        {state === 'full'
          ? 'Today’s limit is used up. Emails resume tomorrow (UTC).'
          : state === 'reserve'
            ? `Optional emails (sign-in alerts, support updates) are paused for today. The last ${cap - optional} are kept for codes and password emails.`
            : state === 'near'
              ? `Getting close: optional emails pause at ${optional}, keeping ${cap - optional} for codes.`
              : `Optional emails pause at ${optional}; the last ${cap - optional} are kept for codes and password emails.`}
      </div>
    </div>
  );
}

const CONNECTION_HELP: Record<string, string> = {
  ip_blocked:
    'Brevo blocks API calls from unknown IP addresses. In Brevo, open Security › Authorised IPs and turn off IP blocking (the app’s servers have no fixed IP).',
  not_activated:
    'Brevo has not activated transactional email for this account yet. Ask Brevo support (contact@brevo.com) to activate it.',
  auth: 'Brevo refused the API key. Check BREVO_API_KEY.',
  network: 'Brevo could not be reached.',
};

export default function EmailAdminPage() {
  const { admin } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Overview>('admin', { json: { action: 'email' } }));
    } catch (err) {
      setError({
        code: err instanceof ApiError ? err.code : 'failed',
        message: err instanceof ApiError ? err.message : 'Email activity could not be loaded.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  const rows = useMemo(() => {
    const all = data?.recent ?? [];
    if (filter === 'failed')
      return all.filter((r) => !r.accepted || r.status === 'bounced' || r.status === 'blocked');
    if (filter === 'awaiting')
      return all.filter((r) => r.accepted && (r.status === 'accepted' || r.status === 'deferred'));
    if (filter === 'delivered') return all.filter((r) => r.status === 'delivered');
    return all;
  }, [data, filter]);

  if (!admin) return <Navigate to="/settings" replace />;
  const refresh = (
    <Button
      size="sm"
      variant="ghost"
      icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />}
      onClick={() => void load()}
      disabled={loading}
    >
      Refresh
    </Button>
  );

  const c = data?.connection;
  return (
    <Page title="Email" back="/settings" wide actions={refresh}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">Email</h1>
          {refresh}
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState
            icon={<Mail className="size-6" />}
            title="Email activity could not be loaded"
            action={<Button onClick={() => void load()}>Try again</Button>}
          >
            {error.message}
          </EmptyState>
        ) : !data || !c ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading email activity
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4">
              <Stat label="Emails requested" value={data.totals.requests} hint="Most recent 500" />
              <Stat
                label="Accepted by Brevo"
                value={data.totals.accepted}
                hint="Brevo took the email; this is not proof of delivery"
              />
              <Stat
                label="Delivered"
                value={data.totals.delivered}
                hint="Brevo reported the receiving mail server accepted it"
              />
              <Stat
                label="Not sent"
                value={data.totals.failed}
                hint="The send request failed (key, IP restriction, quota, network…)"
              />
              <Stat label="Awaiting report" value={data.totals.awaiting} />
              <Stat label="Deferred" value={data.totals.deferred} />
              <Stat label="Bounced" value={data.totals.bounced} />
              <Stat label="Blocked" value={data.totals.blocked} />
            </div>

            <div className="mb-6 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border px-4 py-2">
                <div className="py-2 text-sm font-semibold">Brevo connection</div>
                <Setting label="Status">
                  {c.state === 'connected' ? (
                    <Badge tone="accent">Connected</Badge>
                  ) : c.state === 'error' ? (
                    <Badge tone="danger">Error</Badge>
                  ) : (
                    <Badge>Not configured</Badge>
                  )}
                </Setting>
                {c.plan && <Setting label="Plan">{c.plan}</Setting>}
                {c.credits !== null && (
                  <Setting label="Email credits left">{c.credits.toLocaleString()}</Setting>
                )}
                {c.state === 'error' && (
                  <div className="pb-2 text-xs text-danger">
                    {(c.code && CONNECTION_HELP[c.code]) || c.message}
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-border px-4 py-2">
                <div className="py-2 text-sm font-semibold">Configuration</div>
                <Setting label="API key">
                  {data.config.apiKeySet ? 'Set (server only)' : 'Missing'}
                </Setting>
                <Setting label="Sender">
                  {data.config.sender
                    ? `${data.config.senderName} <${data.config.sender}>`
                    : 'Missing'}
                </Setting>
                <UsageMeter
                  sent={data.config.sentToday}
                  cap={data.config.dailyCap}
                  optional={data.config.optionalLimit}
                />
                <Setting label="Links and logo from">
                  {data.config.publicUrl.replace(/^https?:\/\//, '')}
                </Setting>
                {data.config.senderDomainWarning && (
                  <div className="pb-2 text-xs text-warn">
                    The sender is a free-mail address that Brevo cannot authenticate, so some emails
                    may land in spam. A sender on your own domain fixes this.
                  </div>
                )}
              </div>
            </div>

            {Object.keys(data.byType).length > 0 && (
              <div className="mb-6 flex flex-wrap gap-2">
                {Object.entries(data.byType)
                  .sort((a, b) => b[1] - a[1])
                  .map(([t, n]) => (
                    <span
                      key={t}
                      className="rounded-full border border-border px-3 py-1 text-xs text-muted"
                    >
                      {TYPE_LABEL[t] ?? t} · <b className="font-medium text-fg">{n}</b>
                    </span>
                  ))}
              </div>
            )}

            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Recent activity</h2>
              <div className="w-44">
                <Select
                  value={filter}
                  onChange={setFilter}
                  aria-label="Filter activity"
                  options={[
                    { value: 'all', label: 'All emails' },
                    { value: 'failed', label: 'Failed or bounced' },
                    { value: 'awaiting', label: 'Awaiting report' },
                    { value: 'delivered', label: 'Delivered' },
                  ]}
                />
              </div>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={<Mail className="size-6" />} title="No email activity">
                Emails appear here once users verify an address, reset a password or get a security
                alert.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4"
                  >
                    <div className="text-xs text-muted tabular-nums">{fmt(r.at)}</div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{TYPE_LABEL[r.type] ?? r.type}</div>
                      <div className="truncate text-xs text-muted">
                        {r.to}
                        {r.from ? ` · from ${r.from}` : ''}
                        {r.attempts && r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}
                        {r.opened ? ' · opened' : ''}
                      </div>
                      {(r.error || (r.providerStatus && r.providerStatus !== r.status)) && (
                        <div
                          className={cn(
                            'mt-0.5 break-words text-xs',
                            r.error ? 'text-danger' : 'text-subtle',
                          )}
                        >
                          {r.error ?? `Brevo event: ${r.providerStatus}`}
                        </div>
                      )}
                    </div>
                    <div className="sm:text-right">
                      <StatusBadge row={r} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-muted">
              Failed rows stay in the log as a record; a row that failed before a fix (for example
              an old key or sender) does not mean email is failing now. Accepted means Brevo took
              the email. Delivered means Brevo reported that the recipient’s mail server accepted
              it; it does not show whether it reached the inbox or the spam folder. Message contents
              and codes are never stored.
            </p>
          </>
        )}
      </div>
    </Page>
  );
}
