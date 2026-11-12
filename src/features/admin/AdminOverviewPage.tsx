import { Activity, ArrowRight, Gauge, HeartPulse, Infinity as InfinityIcon, ScrollText, UserPlus, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { Page } from '../shell/Page';
import { usePendingRequests } from '../shell/Sidebar';
import { usageOp, type UsageUserRow } from './usageAdmin';

interface Stats {
  total: number;
  active: number;
  suspended: number;
  newUsers: number;
  newDays: number;
  pendingApproval: number;
}

function Tile({ label, value, hint, to }: { label: string; value: ReactNode; hint?: string; to?: string }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-subtle">{hint}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="rounded-xl border border-border p-3 transition-colors hover:bg-surface sm:p-4">
      {body}
    </Link>
  ) : (
    <div className="rounded-xl border border-border p-3 sm:p-4">{body}</div>
  );
}

const SECTIONS = [
  { to: '/admin/users', icon: Users, label: 'User Management', text: 'Accounts, suspension, deletion and approval.' },
  { to: '/admin/requests', icon: UserPlus, label: 'Access Requests', text: 'Approve or reject new sign-ups.' },
  { to: '/admin/usage', icon: Gauge, label: 'AI Usage & Limits', text: 'Allowances, profiles and resets.' },
  { to: '/admin/unlimited', icon: InfinityIcon, label: 'Unlimited Access', text: 'Grant or remove unlimited AI access.' },
  { to: '/admin/providers', icon: Activity, label: 'Provider Monitoring', text: 'Gemini, Cloudflare, OpenRouter, search and voice.' },
  { to: '/admin/health', icon: HeartPulse, label: 'System Health', text: 'Database, services and deployment.' },
  { to: '/admin/logs', icon: ScrollText, label: 'Audit Logs', text: 'Every administrator change.' },
];

/** Admin Dashboard home: the numbers that need attention, and where to go next. */
export default function AdminOverviewPage() {
  const { admin } = useAuth();
  const pending = usePendingRequests(admin);
  const [stats, setStats] = useState<Stats | null>(null);
  const [usage, setUsage] = useState<UsageUserRow[] | null>(null);
  useEffect(() => {
    api<{ stats: Stats }>('admin', { json: { action: 'list' } })
      .then((r) => setStats(r.stats))
      .catch(() => setStats(null));
    usageOp<{ users: UsageUserRow[] }>({ op: 'users' })
      .then((r) => setUsage(r.users))
      .catch(() => setUsage([]));
  }, []);
  const exhausted = usage?.filter((u) => u.exhausted.length).length ?? 0;
  const near = usage?.filter((u) => !u.exhausted.length && u.near.length).length ?? 0;
  const unlimited = usage?.filter((u) => u.unlimited === 'grant' || u.unlimited === 'profile').length ?? 0;
  const dash = <Spinner className="size-5" />;

  return (
    <Page title="Admin Dashboard" wide>
      <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Admin Dashboard</h1>
      <p className="mb-6 text-sm text-muted">Overview of accounts, access and AI usage today.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Accounts" value={stats ? stats.total : dash} hint={stats ? `${stats.active} active · ${stats.suspended} suspended` : undefined} to="/admin/users" />
        <Tile label="New accounts" value={stats ? stats.newUsers : dash} hint={stats ? `last ${stats.newDays} days` : undefined} to="/admin/users" />
        <Tile label="Waiting for approval" value={pending} to="/admin/requests" />
        <Tile label="At an AI limit" value={usage ? exhausted : dash} hint={usage ? `${near} near a limit` : undefined} to="/admin/usage" />
        <Tile label="Unlimited grants" value={usage ? unlimited : dash} hint="administrators not counted" to="/admin/unlimited" />
      </div>
      <h2 className="mt-8 mb-3 text-[15px] font-semibold">Sections</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <li key={s.to}>
            <Link to={s.to} className="group flex h-full items-start gap-3 rounded-xl border border-border p-3.5 transition-colors hover:bg-surface">
              <s.icon className="mt-0.5 size-[18px] shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-xs text-muted">{s.text}</div>
              </div>
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
