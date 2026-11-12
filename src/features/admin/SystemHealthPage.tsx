import { CheckCircle2, CircleAlert, CircleMinus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { Page } from '../shell/Page';
import { usageOp } from './usageAdmin';

interface Health {
  database: { ok: boolean; ms: number | null };
  services: {
    serverIdentity: boolean;
    superAdminConfigured: boolean;
    geminiAccounts: number;
    cloudflareAccounts: number;
    openrouter: boolean;
    tavily: boolean;
    serpapi: boolean;
    elevenlabs: boolean;
    email: boolean;
    sms: boolean;
  };
  deployment: { region: string | null; environment: string; commit: string | null };
  checkedAt: number;
}

function Row({ state, label, value }: { state: 'ok' | 'warn' | 'off'; label: string; value: string }) {
  const Icon = state === 'ok' ? CheckCircle2 : state === 'warn' ? CircleAlert : CircleMinus;
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <Icon className={state === 'ok' ? 'size-4 text-accent' : state === 'warn' ? 'size-4 text-warn' : 'size-4 text-subtle'} aria-hidden />
      <span className="min-w-0 flex-1">{label}</span>
      <span className="max-w-[45%] text-right text-xs text-muted">{value}</span>
    </li>
  );
}

/** Which services are set up on the server and whether the database answers. Configured means a setting exists, not that the provider has quota left: see Provider Monitoring for that. */
export default function SystemHealthPage() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    usageOp<Health>({ op: 'health' })
      .then((r) => {
        setH(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Health could not be checked.'))
      .finally(() => setBusy(false));
  }, []);
  useEffect(load, [load]);
  const yes = (b: boolean, on = 'Configured', off = 'Not configured') => ({ state: b ? ('ok' as const) : ('off' as const), value: b ? on : off });
  const count = (n: number, of: number) => ({ state: n >= of ? ('ok' as const) : n > 0 ? ('warn' as const) : ('off' as const), value: `${n} of ${of} accounts configured` });

  return (
    <Page
      title="System Health"
      wide
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={busy} onClick={load}>
          Check again
        </Button>
      }
    >
      <div className="mb-6 hidden items-center justify-between lg:flex">
        <h1 className="text-xl font-semibold tracking-tight">System Health</h1>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={busy} onClick={load}>
          Check again
        </Button>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted">
        "Configured" means the server has the setting; it does not test the provider or use any quota. Live provider status, quotas and cooldowns are in{' '}
        <Link to="/admin/providers" className="text-accent underline-offset-2 hover:underline">
          Provider Monitoring
        </Link>
        .
      </p>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !h ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">Core</h2>
            <ul className="divide-y divide-border rounded-xl border border-border">
              <Row label="Database (Firestore)" {...(h.database.ok ? { state: 'ok', value: `Responding · ${h.database.ms} ms` } : { state: 'warn', value: 'Not responding' })} />
              <Row label="Server identity (service account)" {...yes(h.services.serverIdentity)} />
              <Row label="Super Admin email (ADMIN_EMAILS)" {...(h.services.superAdminConfigured ? { state: 'ok', value: 'Set' } : { state: 'warn', value: 'Not set' })} />
            </ul>
            <h2 className="mt-6 mb-2 text-[15px] font-semibold">Deployment</h2>
            <ul className="divide-y divide-border rounded-xl border border-border">
              <Row state="ok" label="Environment" value={h.deployment.environment} />
              <Row state={h.deployment.region ? 'ok' : 'off'} label="Region" value={h.deployment.region ?? 'Local'} />
              <Row state={h.deployment.commit ? 'ok' : 'off'} label="Version" value={h.deployment.commit ?? 'Local build'} />
            </ul>
          </section>
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">Services</h2>
            <ul className="divide-y divide-border rounded-xl border border-border">
              <Row label="Gemini (chat)" {...count(h.services.geminiAccounts, 2)} />
              <Row label="OpenRouter (free models)" {...yes(h.services.openrouter)} />
              <Row label="Cloudflare Workers AI (images, voice)" {...count(h.services.cloudflareAccounts, 2)} />
              <Row label="Tavily (search)" {...yes(h.services.tavily)} />
              <Row label="SerpAPI (search)" {...yes(h.services.serpapi)} />
              <Row label="ElevenLabs (voice)" {...yes(h.services.elevenlabs)} />
              <Row label="Email (Brevo)" {...yes(h.services.email)} />
              <Row label="SMS (Vynfy)" {...yes(h.services.sms)} />
            </ul>
          </section>
          <p className="text-xs text-subtle lg:col-span-2">Checked {new Date(h.checkedAt).toLocaleString()}.</p>
        </div>
      )}
    </Page>
  );
}
