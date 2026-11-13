import { Construction, Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogoMark } from '@/components/Logo';
import { Badge, Button, Dialog, Input, Label, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

interface Maintenance {
  enabled: boolean;
  title: string;
  message: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

const PRESETS: { label: string; title: string; message: string }[] = [
  {
    label: 'Maintenance',
    title: 'Atlas AI is temporarily unavailable',
    message: 'We’re carrying out maintenance. Please try again in a moment.',
  },
  {
    label: 'Upgrade',
    title: 'We’re upgrading Atlas AI',
    message: 'Atlas AI is getting some improvements and will be back shortly. Your chats and settings are safe.',
  },
  {
    label: 'Incident',
    title: 'Atlas AI is temporarily unavailable',
    message: 'We’re working on a problem and will be back as soon as possible. Thank you for your patience.',
  },
];

const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : '—');

/** The notice exactly as signed-in users see it (smaller). */
function Preview({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-[340px] items-center justify-center rounded-2xl border border-border bg-bg px-6 py-12 text-center">
      <div className="max-w-sm">
        <div className="mb-6 inline-flex items-center gap-2">
          <LogoMark className="size-7" />
          <span className="text-xl font-semibold tracking-tight">
            Atlas <span className="text-accent">AI</span>
          </span>
        </div>
        <div className="text-lg font-semibold tracking-tight">{title || '—'}</div>
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-muted">{message || '—'}</p>
        <div className="mt-6 flex justify-center gap-2 text-xs">
          <span className="rounded-lg border border-border bg-surface px-3 py-1.5 opacity-60">Try again in 5s</span>
          <span className="rounded-lg border border-border bg-surface px-3 py-1.5">Log out</span>
        </div>
      </div>
    </div>
  );
}

export default function MaintenancePage() {
  const toast = useToast();
  const [state, setState] = useState<Maintenance | null>(null);
  const [superAdmin, setSuperAdmin] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<boolean | null>(null);

  const apply = (r: { maintenance: Maintenance; superAdmin: boolean }) => {
    setState(r.maintenance);
    setSuperAdmin(r.superAdmin);
    setTitle(r.maintenance.title);
    setMessage(r.maintenance.message);
  };

  useEffect(() => {
    api<{ maintenance: Maintenance; superAdmin: boolean }>('admin', { json: { action: 'maintenanceGet' } }).then(apply, (e) =>
      setError(e instanceof ApiError ? e.message : 'Maintenance mode could not be loaded.'),
    );
  }, []);

  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      const r = await api<{ maintenance: Maintenance; superAdmin: boolean }>('admin', {
        json: { action: 'maintenanceSet', enabled, title: title.trim(), message: message.trim() },
      });
      apply(r);
      toast(
        enabled === state?.enabled ? 'Notice saved.' : enabled ? 'Maintenance mode is on. Users now see the notice.' : 'Maintenance mode is off. Users can use Atlas AI again.',
        'success',
      );
      setConfirm(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The change could not be saved.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const valid = title.trim().length > 0 && title.trim().length <= 120 && message.trim().length > 0 && message.trim().length <= 600;
  const dirty = state !== null && (title.trim() !== state.title || message.trim() !== state.message);

  return (
    <Page title="Maintenance Mode" wide>
      <div className="max-w-5xl">
        <h1 className="mb-1 hidden items-center gap-2 text-2xl font-semibold tracking-tight lg:flex">
          <Construction className="size-6" aria-hidden="true" /> Maintenance Mode
        </h1>
        <p className="mb-6 text-sm text-muted">
          Switch the app off for users while you work on it. Signed-in users see the notice below instead of their dashboard. The home page and public pages stay open,
          administrators keep full access, and connected applications using the Atlas AI API are not affected.
        </p>

        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : !state ? (
          <Spinner />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-5">
              <div
                className={cn(
                  'flex items-center justify-between gap-4 rounded-2xl border p-5',
                  state.enabled ? 'border-amber-400/60 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-400/10' : 'border-border bg-surface',
                )}
              >
                <div>
                  <div className="flex items-center gap-2 font-semibold">
                    Status
                    {state.enabled ? <Badge tone="warn">On: users are locked out</Badge> : <Badge tone="accent">Off: Atlas AI is available</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Last changed {fmt(state.updatedAt)}
                    {state.updatedBy ? ` by ${state.updatedBy}` : ''}
                  </p>
                </div>
                {superAdmin && (
                  <Button variant={state.enabled ? 'primary' : 'danger'} disabled={saving || !valid} onClick={() => setConfirm(!state.enabled)}>
                    {state.enabled ? 'Turn off' : 'Turn on'}
                  </Button>
                )}
              </div>
              {!superAdmin && <p className="text-sm text-muted">Only the Super Admin can switch maintenance mode or change the notice.</p>}

              <div>
                <Label>Quick messages</Label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <Button
                      key={p.label}
                      size="sm"
                      variant="outline"
                      disabled={!superAdmin}
                      onClick={() => {
                        setTitle(p.title);
                        setMessage(p.message);
                      }}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <Label htmlFor="mt-title">Title</Label>
                <Input id="mt-title" value={title} maxLength={120} disabled={!superAdmin} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="mt-message">Message</Label>
                <Textarea id="mt-message" rows={4} value={message} maxLength={600} disabled={!superAdmin} onChange={(e) => setMessage(e.target.value)} />
                <p className="mt-1 text-xs text-muted">{message.trim().length}/600</p>
              </div>
              {superAdmin && (
                <Button variant="secondary" disabled={!dirty || !valid || saving} loading={saving && confirm === null} onClick={() => void save(state.enabled)}>
                  Save notice
                </Button>
              )}
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
                <li>Users already in the app see the notice on their next action (sending a message, opening a chat) or when they reload.</li>
                <li>The notice checks again every minute and opens the app by itself when you turn maintenance off.</li>
                <li>Every change is recorded in the Audit Logs.</li>
              </ul>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <Eye className="size-4" aria-hidden="true" /> What users see
              </div>
              <Preview title={title.trim()} message={message.trim()} />
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? 'Turn maintenance mode on?' : 'Turn maintenance mode off?'}
        description={
          confirm
            ? 'All signed-in users except administrators will be locked out of their dashboard and see the notice until you turn it off.'
            : 'Users will be able to use Atlas AI again straight away.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant={confirm ? 'danger' : 'primary'} loading={saving} onClick={() => void save(Boolean(confirm))}>
              {confirm ? 'Turn on' : 'Turn off'}
            </Button>
          </>
        }
      />
    </Page>
  );
}
