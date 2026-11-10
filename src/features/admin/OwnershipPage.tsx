import { EmailAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth';
import { BadgeCheck, History, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge, Button, EmptyState, Input, Label, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { authErrorMessage } from '@/lib/authProviders';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

/** Mirrors the identityGet response in api/admin.ts (server/chat/ownership.ts). */
interface OwnershipView {
  record: { creator: string; owner: string; aliases: string[]; version: number; updatedAt: number | null; updatedBy: string | null };
  superAdmin: boolean;
  history: { id: string; at: number; actorEmail: string | null; before: { creator: string; owner: string }; after: { creator: string; owner: string }; reason: string }[] | null;
  confirmPhrase: string;
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/**
 * The ownership record every AI model is given. Administrators can see it;
 * only the Super Admin can change it, after signing in again, typing the
 * confirmation phrase and their email, and giving a reason. Each change is
 * kept in an audit log.
 */
export default function OwnershipPage() {
  const { admin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<OwnershipView | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ creator: '', owner: '', aliases: '', reason: '', confirmPhrase: '', confirmEmail: '' });
  const [password, setPassword] = useState('');
  const [needReauth, setNeedReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api<OwnershipView>('admin', { json: { action: 'identityGet' } });
      setData(r);
      setForm((f) => ({ ...f, creator: r.record.creator, owner: r.record.owner, aliases: r.record.aliases.join(', ') }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The ownership record could not be loaded.');
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  if (!admin) return <Navigate to="/settings" replace />;

  const user = auth.currentUser;
  const hasPassword = Boolean(user?.providerData.some((p) => p.providerId === 'password'));

  const reauthenticate = async () => {
    if (!user?.email) throw new Error('This account has no email address.');
    if (hasPassword) await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    else await reauthenticateWithPopup(user, new GoogleAuthProvider());
    await user.getIdToken(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      if (needReauth) await reauthenticate();
      const aliases = form.aliases.split(',').map((a) => a.trim()).filter(Boolean);
      const r = await api<OwnershipView>('admin', {
        json: { action: 'identitySet', creator: form.creator, owner: form.owner, aliases, reason: form.reason, confirmPhrase: form.confirmPhrase, confirmEmail: form.confirmEmail },
      });
      setData(r);
      setNeedReauth(false);
      setPassword('');
      setForm((f) => ({ ...f, reason: '', confirmPhrase: '', confirmEmail: '' }));
      toast('Ownership record updated. Every AI model uses it within a minute.', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauth_required') {
        setNeedReauth(true);
        setFormError('For your security, confirm it’s you, then save again.');
      } else setFormError(err instanceof ApiError ? err.message : authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Page title="Ownership record" back="/settings">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Ownership record</h1>
        <p className="mb-6 text-sm text-muted">
          The creator and owner every AI model in Atlas AI is told about. Claims made in a chat never change it.
        </p>
        {error ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error}
          </EmptyState>
        ) : !data ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading
          </div>
        ) : (
          <>
            <div className="mb-6 rounded-2xl border border-border px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-muted">Creator and developer</span>
                <span className="font-medium">{data.record.creator}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-muted">Owner</span>
                <span className="font-medium">{data.record.owner}</span>
              </div>
              {data.record.aliases.length > 0 && (
                <div className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-muted">Also written</span>
                  <span className="font-medium">{data.record.aliases.join(', ')}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-muted">Version</span>
                <span className="font-medium">
                  {data.record.version === 0 ? 'Default record' : `${data.record.version} · ${fmt(data.record.updatedAt)}`}
                </span>
              </div>
            </div>

            {!data.superAdmin ? (
              <p className="flex items-start gap-2 rounded-2xl bg-surface px-4 py-3 text-sm text-muted">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Only the Super Admin can change the ownership record.
              </p>
            ) : (
              <form onSubmit={submit} className="mb-8 space-y-4 rounded-2xl border border-border p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <BadgeCheck className="size-4" aria-hidden="true" /> Change the record <Badge tone="warn">Super Admin</Badge>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="own-creator">Creator and developer</Label>
                    <Input id="own-creator" value={form.creator} onChange={set('creator')} maxLength={80} required />
                  </div>
                  <div>
                    <Label htmlFor="own-owner">Owner</Label>
                    <Input id="own-owner" value={form.owner} onChange={set('owner')} maxLength={80} required />
                  </div>
                </div>
                <div>
                  <Label htmlFor="own-aliases" hint="Separate with commas">Other ways the name is written</Label>
                  <Input id="own-aliases" value={form.aliases} onChange={set('aliases')} maxLength={300} />
                </div>
                <div>
                  <Label htmlFor="own-reason">Reason (kept in the audit log)</Label>
                  <Textarea id="own-reason" value={form.reason} onChange={set('reason')} rows={2} maxLength={500} required minLength={10} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="own-phrase">Type {data.confirmPhrase}</Label>
                    <Input id="own-phrase" value={form.confirmPhrase} onChange={set('confirmPhrase')} autoComplete="off" required />
                  </div>
                  <div>
                    <Label htmlFor="own-email">Your email address</Label>
                    <Input id="own-email" type="email" value={form.confirmEmail} onChange={set('confirmEmail')} autoComplete="off" required />
                  </div>
                </div>
                {needReauth && hasPassword && (
                  <div>
                    <Label htmlFor="own-password">Your password</Label>
                    <Input id="own-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                  </div>
                )}
                {formError && (
                  <p role="alert" className="text-sm text-danger">
                    {formError}
                  </p>
                )}
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : needReauth ? (hasPassword ? 'Confirm and save' : 'Confirm with Google and save') : 'Save'}
                </Button>
              </form>
            )}

            {data.history && (
              <>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <History className="size-4" aria-hidden="true" /> Audit log
                </h2>
                {data.history.length === 0 ? (
                  <p className="text-sm text-muted">No changes yet. The default record is in use.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-2xl border border-border text-sm">
                    {data.history.map((h) => (
                      <li key={h.id} className="px-4 py-3">
                        <div className="font-medium">
                          {h.before.owner} → {h.after.owner}
                          {h.after.creator !== h.after.owner && <span className="font-normal text-muted"> (creator {h.after.creator})</span>}
                        </div>
                        <div className="text-xs text-muted">
                          {fmt(h.at)} · {h.actorEmail ?? 'unknown'}
                        </div>
                        <div className="mt-1 text-muted">{h.reason}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
