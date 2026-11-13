import { AlertTriangle, Download, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, Input, Label } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { CONTACT_EMAIL } from '../legal/content';
import { useVerifiedEmailGuard } from './EmailVerification';
import { Row, Section } from './parts';

const GRACE_DAYS = 30;

type Step = 'explain' | 'code';

const dateText = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Settings › Security › Delete account. The account is switched off at once and
 * deleted for good after 30 days; until then an administrator can restore it.
 * The server asks for a fresh email code (step-up) and refuses administrator accounts.
 */
export function DeleteAccountSection({ onExport }: { onExport: () => void }) {
  const { admin } = useAuth();
  const { guard, dialog: verifyDialog } = useVerifiedEmailGuard();
  const [open, setOpen] = useState(false);

  return (
    <>
      {verifyDialog}
      <Section title="Delete account">
        <Row
          title="Delete your account"
          description={
            admin
              ? 'Administrator accounts cannot be deleted from here. Remove the administrator role first.'
              : `Your account is switched off at once and permanently deleted after ${GRACE_DAYS} days. Until then it can be restored if you change your mind.`
          }
        >
          <Button
            size="sm"
            variant="outline"
            className="text-danger"
            icon={<Trash2 className="size-4" />}
            disabled={admin}
            onClick={guard(() => setOpen(true), 'delete your account')}
          >
            Delete account
          </Button>
        </Row>
      </Section>
      {open && <DeleteAccountDialog onClose={() => setOpen(false)} onExport={onExport} />}
    </>
  );
}

function DeleteAccountDialog({ onClose, onExport }: { onClose: () => void; onExport: () => void }) {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState<Step>('explain');
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const message = (err: unknown, fallback: string) =>
    err instanceof ApiError && err.message ? err.message : fallback;

  const sendCode = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ sentTo: string }>('account', {
        json: { action: 'emailCodeSend', purpose: 'sensitive' },
      });
      setSentTo(r.sentTo);
      setStep('code');
    } catch (err) {
      setError(message(err, 'The code could not be sent. Try again in a minute.'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('account', {
        json: { action: 'emailCodeVerify', purpose: 'sensitive', code: code.trim() },
      });
      const r = await api<{ purgeAfter: number }>('account', {
        json: { action: 'deleteAccount', confirm: 'DELETE' },
      });
      toast(`Your account was deleted. It can be restored until ${dateText(r.purgeAfter)}.`, 'info');
      await signOut();
    } catch (err) {
      setError(message(err, 'Your account could not be deleted. Try again.'));
      setBusy(false);
    }
  };

  const until = dateText(Date.now() + GRACE_DAYS * 86_400_000);

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="Delete your account?"
      footer={
        step === 'explain' ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={typed.trim().toUpperCase() !== 'DELETE'}
              onClick={() => void sendCode()}
            >
              Email me a code
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="submit"
              form="delete-account-form"
              loading={busy}
              disabled={!/^\d{6}$/.test(code.trim())}
            >
              Delete my account
            </Button>
          </>
        )
      }
    >
      {step === 'explain' ? (
        <div className="space-y-4 text-sm">
          <ul className="space-y-2 text-muted">
            <li>
              <span className="font-medium text-fg">Right away:</span> you are signed out on every
              device and nobody can sign in to the account.
            </li>
            <li>
              <span className="font-medium text-fg">For {GRACE_DAYS} days</span> (until about{' '}
              {until}): your conversations, memories, documents and settings are kept. To restore the
              account, write to <span className="text-fg">{CONTACT_EMAIL}</span>.
            </li>
            <li>
              <span className="font-medium text-fg">After that:</span> everything is deleted for good
              and cannot be recovered.
            </li>
          </ul>
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1.5 text-accent hover:underline"
          >
            <Download className="size-4" /> Export your data first
          </button>
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono font-semibold">DELETE</span> to continue
            </Label>
            <Input
              id="delete-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </div>
          {error && <p className="text-danger">{error}</p>}
        </div>
      ) : (
        <form id="delete-account-form" onSubmit={(e) => void confirm(e)} className="space-y-4 text-sm">
          <p className="text-muted">
            We sent a 6-digit code to <span className="text-fg">{sentTo || user?.email}</span>. Enter
            it to delete your account.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="delete-code">Code</Label>
            <Input
              id="delete-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
            />
          </div>
          <p className="flex items-start gap-2 text-muted">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            You will be signed out straight away.
          </p>
          {error && <p className="text-danger">{error}</p>}
          <button
            type="button"
            className="text-accent hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => void sendCode()}
          >
            Send a new code
          </button>
        </form>
      )}
    </Dialog>
  );
}
